"""Send the incident emails the alert engine records, every ``--interval`` seconds or ``--once``.

A process of its own, beside the alert engine, with the runtime database login and
the SMTP settings (the only process that needs the SMTP password). It refuses to
start while email is off (``SENTINEL_SMTP_HOST`` unset). It never applies
migrations: started before they are applied, it waits for them (``--once``
refuses instead). Several notifiers can run at once: each claims its rows
with ``FOR UPDATE SKIP LOCKED`` (``apps.alerts.notifications``). A run that took a
full batch is followed at once by the next. SIGTERM and SIGINT stop it after the
email in progress, the rest of the run handed back; ``--liveness-file`` is for a
container health check (``apps.alerts.runtime``), kept current between emails.
"""

from __future__ import annotations

import logging
import threading

from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, connection
from django.utils import timezone

from apps.alerts.notifications import BATCH, DeliveryReport, deliver, email_enabled, password_missing
from apps.alerts.runtime import mark_alive, stopped_by_signals, unapplied_migrations, wait_for_migrations

logger = logging.getLogger("apps.alerts.notifier")

MIN_INTERVAL, MAX_INTERVAL = 5, 3600
DEFAULT_INTERVAL = 15
MAX_BATCH = 1000


class Notifier:
    def __init__(
        self, *, interval: int, batch: int = BATCH, stop: threading.Event | None = None, liveness: str | None = None
    ) -> None:
        self.interval = interval
        self.batch = batch
        self.stop = stop or threading.Event()
        self.liveness = liveness
        # Each email is bounded by the SMTP timeouts (a few commands, each at most a minute).
        self.alive_within = 2 * interval + 600
        self.report: DeliveryReport | None = None

    def between_emails(self) -> bool:
        """Asked before each email: still alive, and whether to stop (the rest is handed back)."""
        mark_alive(self.liveness, within=self.alive_within)
        return self.stop.is_set()

    def cycle(self) -> str:
        """One run: ``done``, ``full`` (it took a whole batch: more may be due) or ``failed``."""
        try:
            self.report = deliver(timezone.now(), limit=self.batch, should_stop=self.between_emails)
        except Exception:
            logger.exception("email delivery failed")
            return "failed"
        if self.report.claimed:
            (logger.warning if self.report.failed else logger.info)("email delivery: %s", self.report)
        return "full" if self.report.claimed >= self.batch else "done"

    def serve(self) -> None:
        logger.info("notifier started: sending every %s s", self.interval)
        while not self.stop.is_set():
            mark_alive(self.liveness, within=self.alive_within)
            close_old_connections()
            outcome = self.cycle()
            if outcome == "failed":
                connection.close()  # a broken connection is opened again for the next run
            if outcome != "full":
                self.stop.wait(self.interval)
        logger.info("notifier stopped")


class Command(BaseCommand):
    help = "Send the incident emails that are due, every --interval seconds (or --once)."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Send what is due once and exit.")
        parser.add_argument(
            "--interval",
            type=int,
            default=DEFAULT_INTERVAL,
            help=f"Seconds between runs ({MIN_INTERVAL}-{MAX_INTERVAL}, default {DEFAULT_INTERVAL}).",
        )
        parser.add_argument("--batch", type=int, default=BATCH, help=f"Emails claimed per run (1-{MAX_BATCH}, default {BATCH}).")
        parser.add_argument("--liveness-file", help="A file to keep current for a container health check.")

    def handle(self, *args, once: bool, interval: int, batch: int, liveness_file: str | None = None, **options):
        if not MIN_INTERVAL <= interval <= MAX_INTERVAL:
            raise CommandError(f"--interval must be between {MIN_INTERVAL} and {MAX_INTERVAL} seconds.")
        if not 1 <= batch <= MAX_BATCH:
            raise CommandError(f"--batch must be between 1 and {MAX_BATCH}.")
        if not email_enabled():
            raise CommandError("Email notifications are off: set SENTINEL_SMTP_HOST and SENTINEL_EMAIL_FROM to send them.")
        if password_missing():
            raise CommandError("SENTINEL_SMTP_USER is set without SENTINEL_SMTP_PASSWORD: the notifier would not log in.")
        notifier = Notifier(interval=interval, batch=batch, liveness=liveness_file)
        if once:
            pending = unapplied_migrations()
            if pending:
                raise CommandError(f"{len(pending)} migration(s) not applied. Apply them first: the notifier never migrates.")
            if notifier.cycle() == "failed":
                raise CommandError("Sending failed; see the log.")
            self.stdout.write(f"Delivered: {notifier.report}.")
            return
        try:
            with stopped_by_signals(notifier.stop):
                ready = wait_for_migrations(
                    notifier.stop, logger=logger, liveness=liveness_file, within=notifier.alive_within
                )
                if ready:
                    notifier.serve()
        finally:
            connection.close()
