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

Test emails asked for in the console are sent first in each run, and also between
the incident emails of a long run, and a test email asked for while it waits starts
the next run early: someone is waiting for it, and it expires after ten minutes.
Each run is recorded in ``NotifierHeartbeat`` (with a sign of life now and then during
a long one), with what it saw of the SMTP server: when it reached it, and when it could
not reach it or log in to it, and why.
"""

from __future__ import annotations

import logging
import threading
import time

from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, connection
from django.utils import timezone

from apps.alerts.notifications import (
    BATCH,
    NOTIFIER_INTERVAL,
    DeliveryReport,
    TestEmailReport,
    deliver,
    deliver_test_emails,
    email_enabled,
    password_missing,
    record_notifier_activity,
    record_notifier_beat,
    record_notifier_failure,
    server_events,
)
from apps.alerts.models import TestEmailRequest
from apps.alerts.runtime import mark_alive, stopped_by_signals, unapplied_migrations, wait_for_migrations

logger = logging.getLogger("apps.alerts.notifier")

MIN_INTERVAL, MAX_INTERVAL = 5, 3600
DEFAULT_INTERVAL = NOTIFIER_INTERVAL
MAX_BATCH = 1000
# How often, at most, a long run records a sign of life, and looks for test emails.
ACTIVITY_EVERY = 30
TEST_EMAIL_POLL = 15


class Notifier:
    def __init__(
        self,
        *,
        interval: int,
        batch: int = BATCH,
        stop: threading.Event | None = None,
        liveness: str | None = None,
        clock=time.monotonic,
    ) -> None:
        self.interval = interval
        self.clock = clock
        self.batch = batch
        self.stop = stop or threading.Event()
        self.liveness = liveness
        # Each email is bounded by the SMTP timeouts (a few commands, each at most a minute).
        self.alive_within = 2 * interval + 600
        self.started_at = timezone.now()
        self.report: DeliveryReport | None = None
        self.test_report: TestEmailReport | None = None
        # What the current cycle saw of the SMTP server, and when.
        self.reached_at = self.server_error_at = None
        self.server_error: str | None = None
        self._active = self._tested = 0.0

    def alive(self) -> bool:
        """Asked before each test email: still alive, and whether to stop."""
        mark_alive(self.liveness, within=self.alive_within)
        if time.monotonic() - self._active >= ACTIVITY_EVERY:
            self._active = time.monotonic()
            try:
                record_notifier_activity(timezone.now(), started_at=self.started_at, interval=self.interval)
            except Exception:  # noqa: BLE001 - the emails matter more than the heartbeat
                logger.exception("the notifier heartbeat could not be recorded")
        return self.stop.is_set()

    def between_emails(self) -> bool:
        """Asked before each incident email: still alive, the test emails asked for meanwhile
        sent, and whether to stop (the rest is handed back)."""
        if self.alive():
            return True
        if time.monotonic() - self._tested >= TEST_EMAIL_POLL:
            try:
                self.send_test_emails()
            except Exception:  # noqa: BLE001 - a side task: the incident emails of the run go on
                logger.exception("test emails could not be sent between incident emails")
        return self.stop.is_set()

    def note(self, report) -> None:
        """Keep the latest of what a run saw of the SMTP server."""
        if report.reached_at is not None and (self.reached_at is None or report.reached_at > self.reached_at):
            self.reached_at = report.reached_at
        if report.put_off_at is not None and (self.server_error_at is None or report.put_off_at > self.server_error_at):
            self.server_error_at, self.server_error = report.put_off_at, report.put_off

    def server(self) -> dict:
        return server_events(self.reached_at, self.server_error_at, self.server_error)

    def send_test_emails(self) -> None:
        self._tested = time.monotonic()
        report = deliver_test_emails(timezone.now(), should_stop=self.alive)
        self.note(report)
        if report.claimed:
            (logger.warning if report.failed else logger.info)("test emails: %s", report)
        if self.test_report is None:
            self.test_report = report
        else:
            for name in ("claimed", "sent", "failed", "cancelled", "released"):
                setattr(self.test_report, name, getattr(self.test_report, name) + getattr(report, name))

    def cycle(self) -> str:
        """One run: ``done``, ``full`` (it took a whole batch: more may be due) or ``failed``.

        The test emails asked for in the console first (someone is waiting for each),
        then the incident emails; recorded in ``NotifierHeartbeat`` either way.
        """
        began = time.monotonic()
        self.test_report = None
        self.reached_at = self.server_error_at = self.server_error = None
        try:
            record_notifier_activity(timezone.now(), started_at=self.started_at, interval=self.interval)
            self._active = time.monotonic()
            self.send_test_emails()
            self.report = deliver(timezone.now(), limit=self.batch, should_stop=self.between_emails)
            self.note(self.report)
            # Completed, whatever the SMTP server did: what it did is recorded as it happened
            # (a cycle with nothing to send says nothing of it).
            record_notifier_beat(
                timezone.now(), started_at=self.started_at, interval=self.interval,
                duration_ms=int((time.monotonic() - began) * 1000), server=self.server(),
            )
        except Exception as exc:
            logger.exception("email delivery failed")
            try:
                record_notifier_failure(
                    timezone.now(), started_at=self.started_at, interval=self.interval, error=exc, server=self.server()
                )
            except Exception:
                logger.exception("the failure could not be recorded in the notifier heartbeat")
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
                self.wait()
        logger.info("notifier stopped")

    def wait(self) -> None:
        """Until the next run: the interval, or less when a test email is asked for meanwhile."""
        deadline = self.clock() + self.interval
        while not self.stop.is_set():
            left = deadline - self.clock()
            if left <= 0 or self.stop.wait(min(left, TEST_EMAIL_POLL)):
                return
            try:
                if TestEmailRequest.objects.filter(status=TestEmailRequest.Status.PENDING).exists():
                    return
            except Exception:  # noqa: BLE001 - the run itself will say what is wrong
                return


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
            self.stdout.write(f"Delivered: {notifier.report}; {notifier.test_report}.")
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
