"""Answer the domain verifications asked for in the console, every ``--interval`` seconds or ``--once``.

A process of its own, with the runtime database login: the only one that asks the
DNS about customers' domains (``apps.web.dns_verification``). It never applies
migrations: started before they are applied, it waits for them (``--once`` refuses
instead). Each cycle claims up to ``--concurrency`` requests (``FOR UPDATE SKIP
LOCKED``: several verifiers can run at once), verifies them side by side with no
database transaction open, and records each answer while its claim still holds. A
cycle that took a full set is followed at once by the next. SIGTERM and SIGINT stop
it after the cycle in progress, which the DNS deadline bounds; ``--liveness-file``
is for a container health check (``apps.alerts.runtime``). Each cycle is recorded in
``DomainVerifierHeartbeat``.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, connection
from django.utils import timezone

from apps.alerts.runtime import mark_alive, stopped_by_signals, unapplied_migrations, wait_for_migrations
from apps.web import dns_verification as dns
from apps.web.verification import (
    VERIFIER_INTERVAL,
    Claimed,
    claim,
    expire_verifications,
    finish,
    record_verifier_beat,
    record_verifier_failure,
)

logger = logging.getLogger("apps.web.verifier")

MIN_INTERVAL, MAX_INTERVAL = 1, 60
DEFAULT_CONCURRENCY, MAX_CONCURRENCY = 4, 16


class Verifier:
    def __init__(
        self,
        *,
        interval: int = VERIFIER_INTERVAL,
        concurrency: int = DEFAULT_CONCURRENCY,
        stop: threading.Event | None = None,
        liveness: str | None = None,
        verify=None,
    ) -> None:
        self.interval = interval
        self.concurrency = concurrency
        self.stop = stop or threading.Event()
        self.liveness = liveness
        self.verify = verify or dns.verify
        # A cycle is bounded by the DNS deadline, and recording the answers.
        self.alive_within = 2 * interval + dns.LIMITS.deadline + 120
        self.started_at = timezone.now()
        self.answered = 0

    def check(self, claimed: Claimed) -> dns.Result:
        """The DNS's answer for one request; never raises (a failure is an indeterminate answer)."""
        try:
            return self.verify(claimed.domain, claimed.values())
        except Exception:  # noqa: BLE001 - one request's failure is its answer, not the cycle's
            logger.exception("verifying domain %s failed", claimed.domain_id)
            return dns.Result(dns.INDETERMINATE, dns.INTERNAL_ERROR)

    def cycle(self) -> str:
        """One cycle: ``idle`` (nothing to do), ``done``, ``full`` (more may be waiting) or ``failed``."""
        began = time.monotonic()
        try:
            expire_verifications(timezone.now())
            claimed = claim(timezone.now(), limit=self.concurrency)
            if claimed:
                with ThreadPoolExecutor(max_workers=len(claimed), thread_name_prefix="domain-verifier") as pool:
                    results = list(pool.map(self.check, claimed))
                for item, result in zip(claimed, results, strict=True):
                    if finish(item, result, timezone.now()):
                        self.answered += 1
                        logger.info("domain %s: %s (%s)", item.domain_id, result.outcome, result.detail)
                    else:
                        logger.warning("domain %s: the request was taken by another verifier meanwhile", item.domain_id)
            record_verifier_beat(
                timezone.now(), started_at=self.started_at, interval=self.interval,
                duration_ms=int((time.monotonic() - began) * 1000),
            )
        except Exception as exc:
            logger.exception("domain verification failed")
            try:
                record_verifier_failure(timezone.now(), started_at=self.started_at, interval=self.interval, error=exc)
            except Exception:
                logger.exception("the failure could not be recorded in the verifier heartbeat")
            return "failed"
        if not claimed:
            return "idle"
        return "full" if len(claimed) >= self.concurrency else "done"

    def serve(self) -> None:
        logger.info("domain verifier started: looking for requests every %s s", self.interval)
        while not self.stop.is_set():
            mark_alive(self.liveness, within=self.alive_within)
            close_old_connections()
            outcome = self.cycle()
            if outcome == "failed":
                connection.close()  # a broken connection is opened again for the next cycle
            if outcome != "full":
                self.stop.wait(self.interval)
        logger.info("domain verifier stopped")


class Command(BaseCommand):
    help = "Verify the domains whose verification was asked for, every --interval seconds (or --once)."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Answer what is waiting once and exit.")
        parser.add_argument(
            "--interval",
            type=int,
            default=VERIFIER_INTERVAL,
            help=f"Seconds between looks for requests ({MIN_INTERVAL}-{MAX_INTERVAL}, default {VERIFIER_INTERVAL}).",
        )
        parser.add_argument(
            "--concurrency",
            type=int,
            default=DEFAULT_CONCURRENCY,
            help=f"Verifications at once (1-{MAX_CONCURRENCY}, default {DEFAULT_CONCURRENCY}).",
        )
        parser.add_argument("--liveness-file", help="A file to keep current for a container health check.")

    def handle(self, *args, once: bool, interval: int, concurrency: int, liveness_file: str | None = None, **options):
        if not MIN_INTERVAL <= interval <= MAX_INTERVAL:
            raise CommandError(f"--interval must be between {MIN_INTERVAL} and {MAX_INTERVAL} seconds.")
        if not 1 <= concurrency <= MAX_CONCURRENCY:
            raise CommandError(f"--concurrency must be between 1 and {MAX_CONCURRENCY}.")
        verifier = Verifier(interval=interval, concurrency=concurrency, liveness=liveness_file)
        if once:
            pending = unapplied_migrations()
            if pending:
                raise CommandError(f"{len(pending)} migration(s) not applied. Apply them first: the verifier never migrates.")
            if verifier.cycle() == "failed":
                raise CommandError("Verification failed; see the log.")
            self.stdout.write(f"Answered: {verifier.answered} verification(s).")
            return
        try:
            with stopped_by_signals(verifier.stop):
                ready = wait_for_migrations(
                    verifier.stop, logger=logger, liveness=liveness_file, within=verifier.alive_within
                )
                if ready:
                    verifier.serve()
        finally:
            connection.close()
