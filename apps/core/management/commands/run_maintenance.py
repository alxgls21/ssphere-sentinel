"""Run the retention cleanups, at start and then every ``--interval`` seconds, or ``--once``.

The ``maintenance`` service of the Compose stack: the cleanups an operator would
otherwise schedule from cron (docs/server-deployment.md, Retention), each with
the retention its setting gives (``SENTINEL_*_RETENTION_DAYS``). A process of its
own, with the runtime database login, like the other workers. It never applies
migrations: started before they are applied, it waits for them (``--once``
refuses instead).

A cleanup that fails is logged and the next one still runs; ``--once`` then
exits non-zero. Each cleanup deletes in batches, each batch its own transaction,
so a run cut short (SIGTERM past the stop grace period) keeps what it finished,
and the next run takes up the rest. SIGTERM and SIGINT stop the loop after the
cleanup in progress; ``--liveness-file`` is for a container health check
(``apps.alerts.runtime``).
"""

from __future__ import annotations

import io
import logging
import threading

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, connection

from apps.alerts.runtime import mark_alive, stopped_by_signals, unapplied_migrations, wait_for_migrations

logger = logging.getLogger("apps.core.maintenance")

# The cleanups, in order: each a management command that reads its own retention setting.
TASKS = (
    "purge_network_measurements",
    "purge_snmp_data",
    "purge_telemetry_samples",
    "purge_absent_docker_containers",
    "purge_incidents",
    "purge_notifications",
    "clearsessions",
)
MIN_INTERVAL, MAX_INTERVAL = 3600, 7 * 86400
DEFAULT_INTERVAL = 86400
# Alive while each cleanup begins within this long of the last sign of life (a very large purge included).
ALIVE_WITHIN = 6 * 3600
# How often a sign of life is written while waiting for the next run.
WAIT_STEP = 60


def run_tasks(stop: threading.Event | None = None, *, liveness: str | None = None) -> list[str]:
    """Run every cleanup once (until ``stop``); the names of those that failed."""
    failed = []
    for name in TASKS:
        if stop is not None and stop.is_set():
            break
        mark_alive(liveness, within=ALIVE_WITHIN)
        close_old_connections()
        output = io.StringIO()
        try:
            call_command(name, stdout=output, stderr=output)
        except Exception:
            logger.exception("maintenance: %s failed", name)
            failed.append(name)
            connection.close()  # a broken connection is opened again for the next cleanup
            continue
        summary = " ".join(output.getvalue().split())
        logger.info("maintenance: %s: %s", name, summary or "done")
    return failed


class Command(BaseCommand):
    help = "Run the retention cleanups (purge_* and clearsessions) every --interval seconds (or --once)."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Run every cleanup once and exit.")
        parser.add_argument(
            "--interval",
            type=int,
            default=DEFAULT_INTERVAL,
            help=f"Seconds between runs ({MIN_INTERVAL}-{MAX_INTERVAL}, default {DEFAULT_INTERVAL}).",
        )
        parser.add_argument("--liveness-file", help="A file to keep current for a container health check.")

    def handle(self, *args, once: bool, interval: int, liveness_file: str | None = None, **options):
        if not MIN_INTERVAL <= interval <= MAX_INTERVAL:
            raise CommandError(f"--interval must be between {MIN_INTERVAL} and {MAX_INTERVAL} seconds.")
        if once:
            pending = unapplied_migrations()
            if pending:
                raise CommandError(f"{len(pending)} migration(s) not applied. Apply them first: maintenance never migrates.")
            failed = run_tasks()
            if failed:
                raise CommandError(f"Failed: {', '.join(failed)}; see the log.")
            return
        stop = threading.Event()
        try:
            with stopped_by_signals(stop):
                if wait_for_migrations(stop, logger=logger, liveness=liveness_file, within=ALIVE_WITHIN):
                    self.serve(stop, interval=interval, liveness=liveness_file)
        finally:
            connection.close()

    def serve(self, stop: threading.Event, *, interval: int, liveness: str | None) -> None:
        logger.info("maintenance started: the retention cleanups every %s s", interval)
        while not stop.is_set():
            run_tasks(stop, liveness=liveness)
            connection.close()  # no session held between runs
            waited = 0
            while waited < interval and not stop.is_set():
                mark_alive(liveness, within=ALIVE_WITHIN)
                step = min(WAIT_STEP, interval - waited)
                stop.wait(step)
                waited += step
        logger.info("maintenance stopped")
