from django.db import connection

from apps.core.retention import RetentionCommand
from apps.infrastructure.models import ServerTelemetrySample


def delete_samples_in_batches(cutoff, *, batch_size: int) -> tuple[int, int]:
    """Delete samples older than ``cutoff``; returns ``(rows_deleted, batches)``.

    The shared ``delete_in_batches`` selects primary keys and deletes them with
    ``WHERE pk IN (...)``; for this table's two-column key that becomes a list of
    row values, and PostgreSQL overflows its stack parsing one of more than about
    6,500 of them (the batch size may be up to 100,000). Here each batch is a
    single statement that finds its rows through the ``sampled_at`` index and
    deletes them by physical address, so the batch size has no such limit. Each
    batch is its own short transaction (autocommit), as with the shared helper, and
    an interrupted run keeps what it has deleted. Samples are never updated, so
    their addresses cannot move between the subquery and the delete.
    """
    quote = connection.ops.quote_name
    table = quote(ServerTelemetrySample._meta.db_table)
    time = quote("sampled_at")
    sql = (
        f"DELETE FROM {table} WHERE ctid IN "
        f"(SELECT ctid FROM {table} WHERE {time} < %s LIMIT %s)"
    )
    total = batches = 0
    while True:
        with connection.cursor() as cursor:
            cursor.execute(sql, [cutoff, batch_size])
            deleted = cursor.rowcount
        if deleted:
            total += deleted
            batches += 1
        if deleted < batch_size:
            return total, batches


class Command(RetentionCommand):
    help = (
        "Delete server telemetry history samples older than "
        "SENTINEL_TELEMETRY_RETENTION_DAYS, in batches. The latest snapshot of "
        "each server (ServerTelemetry) is never touched."
    )
    default_days_setting = "SENTINEL_TELEMETRY_RETENTION_DAYS"

    def purge(self, *, cutoff, batch_size, dry_run):
        samples = ServerTelemetrySample.objects.filter(sampled_at__lt=cutoff)
        if dry_run:
            self.stdout.write(
                f"Would delete {samples.count()} telemetry sample(s) older than {cutoff.isoformat()}."
            )
            return
        deleted, batches = delete_samples_in_batches(cutoff, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} telemetry sample(s) older than {cutoff.isoformat()} in {batches} batch(es)."
            )
        )
