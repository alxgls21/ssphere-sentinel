"""Delete Docker containers that have been absent for longer than the retention period.

A report can rediscover a container at any moment, so nothing is deleted on the
strength of an earlier look at the table. The cleanup works one server at a
time, in one short transaction per batch, and takes the lock a Docker report
takes first, the server's ``DockerHostState`` row (see
``apps.infrastructure.docker_reports``), before it decides anything:

1. lock the host row (waiting at most ``LOCK_TIMEOUT_MS``);
2. select the eligible containers of that server again, now that no report can
   change them;
3. delete exactly those, with the eligibility conditions repeated in the
   ``DELETE`` itself.

The lock order is the host row, then the container rows (which only the holder
of the host row writes), and no more than one host row is held at a time, so
the cleanup and the ingestion cannot deadlock. The first query only names the
servers that have candidates; it decides nothing.

A server whose host row is missing, or stays locked longer than the timeout, is
deferred: the rest of its cleanup is left for a later run and the reason is
reported. Batches the server had already completed stay deleted (each was
committed under the lock); nothing is ever deleted without it.

The number of batches a server gets in one run is fixed from the number of
eligible containers found when it was first locked (``ceil(count / batch_size)``).
Containers that become eligible meanwhile may still be deleted in that run, if
they fit in those batches; whatever remains eligible afterwards is taken by a
later run, so a server that keeps producing candidates cannot keep one run
busy for ever.
"""

from django.db import OperationalError, connection, transaction

from apps.core.retention import RetentionCommand
from apps.infrastructure.models import DockerContainer, DockerHostState, Server

# How long a cleanup waits for the lock of a server (a Docker report holds it for a few
# milliseconds normally) before it defers the rest of that server to a later run.
LOCK_TIMEOUT_MS = 5000
LOCK_NOT_AVAILABLE = "55P03"

NO_HOST_STATE = "it has no Docker host state to lock"
BUSY = "its Docker host state stayed locked past the timeout (another transaction holds it, such as a Docker report or another cleanup run)"


def is_lock_timeout(error: OperationalError) -> bool:
    """Did PostgreSQL give up waiting for a lock (``lock_timeout``), as opposed to any other failure?"""
    return getattr(error.__cause__, "sqlstate", None) == LOCK_NOT_AVAILABLE


class Command(RetentionCommand):
    help = (
        "Delete Docker containers that have been absent from successful "
        "discoveries for longer than SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS. "
        "Present containers are never deleted. A server whose Docker state cannot "
        "be locked (busy, or missing) is deferred and reported: what is left of "
        "its cleanup waits for a later run."
    )
    default_days_setting = "SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        # Containers only become absent after a successful discovery that no
        # longer lists them, so Docker outages never make rows eligible here.
        eligible = DockerContainer.objects.filter(present=False, last_seen_at__lt=cutoff)
        if dry_run:
            self._dry_run(eligible, cutoff)
            return

        # Only names the servers to look at: every decision is made under their lock.
        servers = list(eligible.order_by("server_id").values_list("server_id", flat=True).distinct())
        deleted = batches = 0
        deferred = {}
        for server_id in servers:
            removed, spent, reason = self._purge_server(server_id, eligible, cutoff, batch_size)
            deleted += removed
            batches += spent
            if reason is not None:
                deferred[server_id] = reason

        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} absent container(s) last seen before "
                f"{cutoff.isoformat()} in {batches} batch(es)."
            )
        )
        if deferred:
            self._report_deferred(deferred)

    def _purge_server(self, server_id, eligible, cutoff, batch_size):
        """Delete the eligible containers of one server; ``(deleted, batches, reason it was deferred or None)``.

        Each batch is its own transaction: lock the host row, select again, delete.
        The number of batches is fixed from the eligible count found when the
        server is first locked (``ceil(count / batch_size)``). Containers that
        become eligible meanwhile may be deleted in the same run if they fit in
        those batches; whatever is still eligible afterwards is left for a later
        run, so a server that keeps producing candidates cannot keep one run busy
        for ever. A deferral part-way keeps the batches already committed.
        """
        deleted = batches = 0
        budget = None
        while budget is None or batches < budget:
            try:
                with transaction.atomic():
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT set_config('lock_timeout', %s, true)", [f"{LOCK_TIMEOUT_MS}ms"])
                    host = DockerHostState.objects.select_for_update().filter(server_id=server_id)
                    if host.values_list("pk", flat=True).first() is None:
                        return deleted, batches, NO_HOST_STATE
                    candidates = eligible.filter(server_id=server_id).order_by()
                    ids = list(candidates.values_list("pk", flat=True)[:batch_size])
                    if not ids:
                        return deleted, batches, None
                    if budget is None:
                        full = len(ids) == batch_size
                        budget = -(-candidates.count() // batch_size) if full else 1
                    removed = (
                        DockerContainer.objects.filter(
                            pk__in=ids, server_id=server_id, present=False, last_seen_at__lt=cutoff
                        )
                        .order_by()
                        .delete()[0]
                    )
            except OperationalError as error:
                if not is_lock_timeout(error):
                    raise
                return deleted, batches, BUSY
            deleted += removed
            batches += 1
            if len(ids) < batch_size:
                break
        return deleted, batches, None

    def _dry_run(self, eligible, cutoff):
        total = eligible.count()
        lockable = eligible.filter(server__docker_host__isnull=False).count()
        message = f"Would delete {lockable} absent container(s) last seen before {cutoff.isoformat()}."
        if lockable != total:
            message += (
                f" {total - lockable} more belong to a server without a Docker host state"
                " and would be left for later."
            )
        self.stdout.write(message)

    def _report_deferred(self, deferred):
        names = dict(Server.objects.filter(pk__in=deferred).values_list("pk", "name"))
        self.stdout.write(
            self.style.WARNING(
                f"Deferred to a later run: {len(deferred)} server(s) whose Docker host state could not be locked. "
                "Batches already completed stay deleted; what is left of their absent containers is kept until then."
            )
        )
        for server_id, reason in sorted(deferred.items(), key=lambda item: str(item[0])):
            self.stdout.write(self.style.WARNING(f"  {names.get(server_id, '?')} ({server_id}): {reason}"))
