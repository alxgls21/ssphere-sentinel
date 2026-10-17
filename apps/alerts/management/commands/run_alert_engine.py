"""Evaluate the alert rules, every ``--interval`` seconds or ``--once``.

A process of its own, beside the web server, with the same (runtime) database
login. It never applies migrations: started before they are applied, it waits for
them (``--once`` refuses instead).
Each cycle holds a PostgreSQL advisory lock: a second engine, or a ``--once`` run
started while one is evaluating, waits its turn instead of evaluating at the same
time. Every cycle is recorded in ``AlertEngineHeartbeat``: when it completed, or
when one failed and with what kind of error. SIGTERM and SIGINT stop the engine
after the cycle in progress. ``--liveness-file`` is for a container health check
(``apps.alerts.runtime``).
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, connection
from django.utils import timezone

from apps.alerts.engine import DEFAULT_INTERVAL, Report, record_failure, run_cycle
from apps.alerts.runtime import mark_alive, stopped_by_signals, unapplied_migrations, wait_for_migrations
from apps.infrastructure.liveness import offline_threshold_seconds

logger = logging.getLogger("apps.alerts.engine")

# The key of the engine's advisory lock: the bytes "SNTLALRT".
LOCK_KEY = int.from_bytes(b"SNTLALRT", "big")
MIN_INTERVAL, MAX_INTERVAL = 5, 3600


@contextmanager
def advisory_lock():
    """Hold the engine's lock for one cycle; yields False when another session holds it."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", [LOCK_KEY])
        held = bool(cursor.fetchone()[0])
    try:
        yield held
    finally:
        if held:
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_unlock(%s)", [LOCK_KEY])
            except Exception:
                connection.close()  # the session is gone, and its lock with it


class Engine:
    """The cycles the command runs."""

    def __init__(
        self, *, interval: int, stop: threading.Event | None = None, clock=time.monotonic, liveness: str | None = None
    ) -> None:
        self.interval = interval
        self.liveness = liveness
        self.stop = stop or threading.Event()
        self.clock = clock
        self.started_at = timezone.now()
        # A longer break than this, and an outage of the ingest could have gone unseen.
        self.gap = max(timedelta(seconds=offline_threshold_seconds()), timedelta(seconds=2 * interval))
        self.report: Report | None = None
        self.waiting = False
        self.outage = False

    def cycle(self) -> str:
        """One cycle: ``done``, ``locked`` (another engine is evaluating) or ``failed``."""
        now = timezone.now()
        try:
            with advisory_lock() as held:
                if not held:
                    if not self.waiting:
                        logger.info("another alert engine is evaluating: waiting for its lock")
                    self.waiting = True
                    return "locked"
                self.waiting = False
                self.report = run_cycle(now, started_at=self.started_at, gap=self.gap, interval=self.interval, clock=self.clock)
        except Exception as exc:
            logger.exception("alert evaluation failed")
            try:
                record_failure(now, started_at=self.started_at, error=exc, interval=self.interval)
            except Exception:
                logger.exception("the failure could not be recorded in the alert engine heartbeat")
            return "failed"
        if self.report.monitoring == self.outage:
            self.outage = not self.report.monitoring
            if self.outage:
                logger.warning("nearly every agent has gone silent at once: silences are not counted until they report again")
            else:
                logger.info("agents are reporting: silences count again after the offline threshold")
        (logger.info if self.report.changes or self.report.skipped else logger.debug)("alert evaluation: %s", self.report)
        return "done"

    def serve(self) -> None:
        logger.info("alert engine started: evaluating every %s s", self.interval)
        while not self.stop.is_set():
            # Healthy while each cycle starts within two intervals and two minutes of the last.
            mark_alive(self.liveness, within=2 * self.interval + 120)
            close_old_connections()
            if self.cycle() == "failed":
                connection.close()  # a broken connection is opened again for the next cycle
            self.stop.wait(self.interval)
        logger.info("alert engine stopped")


class Command(BaseCommand):
    help = "Evaluate the alert rules against the monitoring data, every --interval seconds (or --once)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--once",
            action="store_true",
            help="Evaluate once and exit. Scheduled this way, run it at least as often as the offline threshold.",
        )
        parser.add_argument(
            "--interval",
            type=int,
            default=DEFAULT_INTERVAL,
            help=f"Seconds between evaluations ({MIN_INTERVAL}-{MAX_INTERVAL}, default {DEFAULT_INTERVAL}).",
        )
        parser.add_argument("--liveness-file", help="A file to keep current for a container health check.")

    def handle(self, *args, once: bool, interval: int, liveness_file: str | None = None, **options):
        if not MIN_INTERVAL <= interval <= MAX_INTERVAL:
            raise CommandError(f"--interval must be between {MIN_INTERVAL} and {MAX_INTERVAL} seconds.")
        if once:
            pending = unapplied_migrations()
            if pending:
                raise CommandError(
                    f"{len(pending)} migration(s) not applied. Apply them first: the alert engine never migrates."
                )
            engine = Engine(interval=interval, liveness=liveness_file)
            outcome = engine.cycle()
            if outcome == "failed":
                raise CommandError("The evaluation failed; see the log.")
            if outcome == "locked":
                self.stdout.write("Another alert engine is evaluating; nothing done.")
            else:
                self.stdout.write(f"Evaluated: {engine.report}.")
            return
        stop = threading.Event()
        try:
            with stopped_by_signals(stop):
                if wait_for_migrations(stop, logger=logger, liveness=liveness_file, within=2 * interval + 120):
                    Engine(interval=interval, stop=stop, liveness=liveness_file).serve()
        finally:
            connection.close()
