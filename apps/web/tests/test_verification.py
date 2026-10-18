"""The verification queue, the domain verifier, its heartbeat, and what is recorded."""

import io
import threading
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.db import IntegrityError, connection, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from apps.alerts.models import ConfigurationEvent
from apps.console.tests.helpers import make_user
from apps.inventory.models import Customer
from apps.web import dns_verification as dv
from apps.web import verification as queue
from apps.web.domains import new_token
from apps.web.management.commands.run_domain_verifier import Verifier
from apps.web.models import DomainVerification, DomainVerifierHeartbeat, MonitoredDomain


def make_domain(customer, name="example.com", *, now=None):
    now = now or timezone.now()
    return MonitoredDomain.objects.create(
        customer=customer, name=name, display_name=name, token=new_token(), token_created_at=now,
        created_by_name="admin", created_at=now, updated_at=now,
    )


def found(domain, values):
    return dv.Result(dv.VERIFIED, dv.FOUND, {"zone": "example.com", "aliases": [], "nameserverCount": 2, "nameservers": []})


def not_found(domain, values):
    return dv.Result(dv.ABSENT, dv.NOT_FOUND, {"zone": "example.com", "aliases": [], "nameserverCount": 2, "nameservers": []})


class QueueTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.user = get_user_model().objects.create_user("alice")
        self.acme = Customer.objects.create(name="Acme")
        self.domain = make_domain(self.acme)

    def ask(self, *, at=None, domain=None, user=None):
        with transaction.atomic():
            return queue.request_verification(domain or self.domain, user or self.user, at or self.now)

    def test_a_request_waits_for_the_verifier_and_is_recorded(self):
        row = self.ask()
        self.assertEqual((row.status, row.requested_by_name), ("pending", "alice"))
        self.assertEqual(row.expires_at, self.now + queue.VERIFICATION_EXPIRY)
        event = ConfigurationEvent.objects.get(action="domain_verification_requested")
        self.assertEqual((event.actor, event.actor_name, event.source), (self.user, "alice", "console"))
        self.assertEqual((event.target_type, event.target_id, event.target_name), ("domain", str(self.domain.pk), "example.com"))
        self.assertEqual(event.changes, {"verificationId": {"before": None, "after": str(row.pk)}})

    def test_one_open_request_per_domain(self):
        self.ask()
        with self.assertRaises(queue.Refused) as caught:
            self.ask(at=self.now + timedelta(minutes=1))
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "verification_active"))
        # The database refuses a second one however it is attempted.
        with self.assertRaises(IntegrityError), transaction.atomic():
            DomainVerification.objects.create(domain=self.domain, created_at=self.now, expires_at=self.now + timedelta(minutes=1))

    def test_a_domain_waits_between_requests(self):
        row = self.ask()
        DomainVerification.objects.filter(pk=row.pk).update(status="done", outcome="absent", detail="not_found", finished_at=self.now)
        with self.assertRaises(queue.Refused) as caught:
            self.ask(at=self.now + timedelta(seconds=4))
        self.assertEqual((caught.exception.status, caught.exception.retry_after), (429, 6))
        self.ask(at=self.now + queue.DOMAIN_EVERY)

    def test_a_user_has_a_limit_over_many_domains(self):
        domains = [make_domain(self.acme, f"d{n}.example.com") for n in range(queue.USER_LIMIT + 1)]
        for n, domain in enumerate(domains[:-1]):
            self.ask(domain=domain, at=self.now + timedelta(seconds=n))
        with self.assertRaises(queue.Refused) as caught:
            self.ask(domain=domains[-1], at=self.now + timedelta(seconds=30))
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(caught.exception.retry_after, int(queue.USER_WINDOW.total_seconds()) - 30)
        other = get_user_model().objects.create_user("bob")
        self.ask(domain=domains[-1], user=other, at=self.now + timedelta(seconds=30))

    def test_the_queue_is_bounded(self):
        with patch.object(queue, "QUEUE_LIMIT", 2):
            for n in range(2):
                self.ask(domain=make_domain(self.acme, f"q{n}.example.com"), user=get_user_model().objects.create_user(f"u{n}"))
            with self.assertRaises(queue.Refused) as caught:
                self.ask()
        self.assertEqual((caught.exception.status, caught.exception.code), (503, "queue_full"))

    def test_requests_past_their_expiry_do_not_fill_the_queue(self):
        with patch.object(queue, "QUEUE_LIMIT", 2):
            for n in range(2):
                self.ask(domain=make_domain(self.acme, f"s{n}.example.com"), user=get_user_model().objects.create_user(f"s{n}"))
            later = self.now + queue.VERIFICATION_EXPIRY
            self.ask(at=later)  # the two are expired by then, though nothing has marked them

    def test_a_domain_found_again_leaves_its_grace_period(self):
        MonitoredDomain.objects.filter(pk=self.domain.pk).update(
            status="degraded", verified_at=self.now, degraded_since=self.now, grace_until=self.now + timedelta(days=7)
        )
        self.ask()
        [item] = queue.claim(self.now, limit=1)
        queue.finish(item, found(None, None), self.now)
        self.domain.refresh_from_db()
        self.assertEqual((self.domain.status, self.domain.degraded_since, self.domain.grace_until), ("verified", None, None))

    def test_a_request_no_verifier_took_expires(self):
        row = self.ask()
        self.assertEqual(queue.expire_verifications(self.now + queue.VERIFICATION_EXPIRY - timedelta(seconds=1)), 0)
        self.assertEqual(queue.expire_verifications(self.now + queue.VERIFICATION_EXPIRY), 1)
        row.refresh_from_db()
        self.assertEqual((row.status, row.detail, row.outcome), ("expired", "expired", ""))
        # Expired, it no longer blocks a new one.
        self.ask(at=self.now + queue.VERIFICATION_EXPIRY)

    def test_claim_takes_the_oldest_and_never_twice(self):
        rows = [self.ask(domain=make_domain(self.acme, f"c{n}.example.com"), at=self.now + timedelta(seconds=n)) for n in range(3)]
        first = queue.claim(self.now + timedelta(seconds=5), limit=2)
        self.assertEqual([item.id for item in first], [rows[0].pk, rows[1].pk])
        second = queue.claim(self.now + timedelta(seconds=6), limit=5)
        self.assertEqual([item.id for item in second], [rows[2].pk])
        self.assertEqual(queue.claim(self.now + timedelta(seconds=7), limit=5), [])
        self.assertEqual(first[0].values(), [f"ssphere-verification={rows[0].domain.token}"])

    def test_a_request_whose_verifier_died_is_taken_again_after_its_lease(self):
        row = self.ask()
        [held] = queue.claim(self.now, limit=1)
        self.assertEqual(queue.claim(self.now + queue.LEASE - timedelta(seconds=1), limit=1), [])
        [again] = queue.claim(self.now + queue.LEASE, limit=1)
        self.assertEqual(again.id, row.pk)
        self.assertNotEqual(again.claim, held.claim)
        # The first verifier's answer arrives late: its claim no longer holds.
        self.assertFalse(queue.finish(held, found(None, None), self.now + queue.LEASE))
        self.assertTrue(queue.finish(again, not_found(None, None), self.now + queue.LEASE))

    def test_finding_the_record_verifies_the_domain_once_and_is_recorded(self):
        self.ask()
        [item] = queue.claim(self.now, limit=1)
        self.assertTrue(queue.finish(item, found(None, None), self.now + timedelta(seconds=3)))
        self.domain.refresh_from_db()
        self.assertEqual((self.domain.status, self.domain.last_outcome), ("verified", "verified"))
        self.assertEqual(self.domain.verified_at, self.now + timedelta(seconds=3))
        self.assertEqual(self.domain.version, 2)
        row = DomainVerification.objects.get(pk=item.id)
        self.assertEqual((row.status, row.outcome, row.detail, row.claim), ("done", "verified", "found", None))
        event = ConfigurationEvent.objects.get(action="domain_verified")
        self.assertEqual((event.actor, event.actor_name, event.source), (self.user, "alice", "verifier"))
        self.assertEqual(event.changes["status"], {"before": "pending", "after": "verified"})
        self.assertEqual(event.changes["detail"], {"before": None, "after": "found"})
        # A later verification that does not find it changes the outcome only (in this release).
        DomainVerification.objects.all().delete()
        self.ask(at=self.now + timedelta(minutes=1))
        [item] = queue.claim(self.now + timedelta(minutes=1), limit=1)
        queue.finish(item, not_found(None, None), self.now + timedelta(minutes=1, seconds=2))
        self.domain.refresh_from_db()
        self.assertEqual((self.domain.status, self.domain.last_outcome), ("verified", "absent"))
        self.assertEqual(self.domain.verified_at, self.now + timedelta(seconds=3))
        failed = ConfigurationEvent.objects.get(action="domain_verification_failed")
        self.assertEqual(failed.changes["lastOutcome"], {"before": "verified", "after": "absent"})

    def test_the_answer_of_an_account_deleted_meanwhile_keeps_its_name(self):
        self.ask()
        [item] = queue.claim(self.now, limit=1)
        self.user.delete()
        queue.finish(item, not_found(None, None), self.now)
        event = ConfigurationEvent.objects.get(action="domain_verification_failed")
        self.assertEqual((event.actor, event.actor_name), (None, "alice"))

    def test_the_token_is_never_in_the_trail(self):
        self.ask()
        [item] = queue.claim(self.now, limit=1)
        queue.finish(item, found(None, None), self.now)
        for event in ConfigurationEvent.objects.all():
            self.assertNotIn(self.domain.token, str(event.changes) + event.target_name + event.actor_name)


class VerifierTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user("alice")
        self.acme = Customer.objects.create(name="Acme")
        self.now = timezone.now()

    def request(self, name):
        domain = make_domain(self.acme, name)
        with transaction.atomic():
            return queue.request_verification(domain, self.user, self.now - timedelta(minutes=1))

    def test_a_cycle_answers_what_waits_with_the_domain_and_its_value(self):
        rows = [self.request(f"v{n}.example.com") for n in range(3)]
        seen = []

        def verify(domain, values):
            seen.append((domain, values))
            return found(domain, values)

        verifier = Verifier(interval=2, concurrency=2, verify=verify)
        with self.assertLogs("apps.web.verifier", "INFO"):
            self.assertEqual(verifier.cycle(), "full")
            self.assertEqual(verifier.cycle(), "done")
        self.assertEqual(verifier.cycle(), "idle")
        self.assertEqual(sorted(domain for domain, _ in seen), ["v0.example.com", "v1.example.com", "v2.example.com"])
        for domain, values in seen:
            token = MonitoredDomain.objects.get(name=domain).token
            self.assertEqual(values, [f"ssphere-verification={token}"])
        self.assertEqual(set(DomainVerification.objects.values_list("status", flat=True)), {"done"})
        self.assertEqual(MonitoredDomain.objects.filter(status="verified").count(), 3)
        self.assertEqual(verifier.answered, 3)
        beat = DomainVerifierHeartbeat.objects.get()
        self.assertIsNotNone(beat.beat_at)
        self.assertEqual(queue.verifier_state(), "running")
        self.assertEqual(len(rows), 3)

    def test_a_failing_verification_is_an_indeterminate_answer_not_a_failed_cycle(self):
        self.request("broken.example.com")

        def explode(domain, values):
            raise RuntimeError("boom")

        with self.assertLogs("apps.web.verifier", "ERROR"):
            self.assertEqual(Verifier(verify=explode).cycle(), "done")
        row = DomainVerification.objects.get()
        self.assertEqual((row.status, row.outcome, row.detail), ("done", "indeterminate", "internal_error"))
        self.assertEqual(MonitoredDomain.objects.get().status, "pending")

    def test_a_database_failure_is_recorded_in_the_heartbeat(self):
        from django.db import OperationalError

        with patch("apps.web.management.commands.run_domain_verifier.claim", side_effect=OperationalError("gone")):
            with self.assertLogs("apps.web.verifier", "ERROR"):
                self.assertEqual(Verifier().cycle(), "failed")
        beat = DomainVerifierHeartbeat.objects.get()
        self.assertEqual((beat.last_error_category, beat.last_error_type), ("database", "OperationalError"))
        self.assertEqual(queue.verifier_state(), "failed")

    def test_states_of_the_verifier(self):
        now = timezone.now()
        self.assertEqual(queue.verifier_state(now), "never_started")
        queue.record_verifier_beat(now, started_at=now, interval=2, duration_ms=5)
        self.assertEqual(queue.verifier_state(now), "running")
        self.assertEqual(queue.verifier_state(now + timedelta(seconds=6) + queue.STALE_AFTER), "running")
        self.assertEqual(queue.verifier_state(now + timedelta(seconds=7) + queue.STALE_AFTER), "stale")
        queue.record_verifier_failure(now + timedelta(seconds=1), started_at=now, interval=2, error=ValueError())
        self.assertEqual(queue.verifier_state(now + timedelta(seconds=1)), "failed")
        queue.record_verifier_beat(now + timedelta(seconds=2), started_at=now, interval=2, duration_ms=5)
        self.assertEqual(queue.verifier_state(now + timedelta(seconds=2)), "running")

    def test_once(self):
        self.request("once.example.com")
        out = io.StringIO()
        with patch("apps.web.management.commands.run_domain_verifier.dns.verify", side_effect=not_found) as verify:
            with self.assertLogs("apps.web.verifier", "INFO"):
                call_command("run_domain_verifier", "--once", stdout=out)
        verify.assert_called_once()
        self.assertEqual(out.getvalue().strip(), "Answered: 1 verification(s).")
        self.assertEqual(DomainVerification.objects.get().outcome, "absent")

    def test_arguments_are_checked(self):
        for args in (["--interval", "0"], ["--interval", "61"], ["--concurrency", "0"], ["--concurrency", "17"]):
            with self.subTest(args=args), self.assertRaises(CommandError):
                call_command("run_domain_verifier", "--once", *args)


class ConcurrentClaimTests(TransactionTestCase):
    def test_two_verifiers_never_take_the_same_request(self):
        user = get_user_model().objects.create_user("alice")
        acme = Customer.objects.create(name="Acme")
        now = timezone.now()
        for n in range(6):
            with transaction.atomic():
                queue.request_verification(make_domain(acme, f"p{n}.example.com"), user, now + timedelta(seconds=n))
        barrier = threading.Barrier(2)
        taken: list[list] = []

        def take():
            try:
                with transaction.atomic():
                    barrier.wait(timeout=10)
                    taken.append([item.id for item in queue.claim(now + timedelta(minutes=1), limit=4)])
            finally:
                connection.close()

        threads = [threading.Thread(target=take) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        ids = [pk for batch in taken for pk in batch]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), 6)


class AdminTests(TestCase):
    def test_the_admin_shows_domains_and_verifications_read_only_without_the_token(self):
        acme = Customer.objects.create(name="Acme")
        domain = make_domain(acme, "xn--bcher-kva.de")
        with transaction.atomic():
            verification = queue.request_verification(domain, get_user_model().objects.create_user("alice"), timezone.now())
        self.client.force_login(make_user("root", superuser=True))
        page = self.client.get(f"/admin/web/monitoreddomain/{domain.pk}/change/")
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, "xn--bcher-kva.de")
        self.assertNotContains(page, domain.token)
        self.assertNotContains(page, 'name="_save"')
        self.assertEqual(self.client.get("/admin/web/monitoreddomain/").status_code, 200)
        self.assertEqual(self.client.get(f"/admin/web/domainverification/{verification.pk}/change/").status_code, 200)
        self.assertEqual(self.client.get("/admin/web/domainverifierheartbeat/").status_code, 200)
        self.assertEqual(self.client.post(f"/admin/web/monitoreddomain/{domain.pk}/delete/", {"post": "yes"}).status_code, 403)
        self.assertEqual(self.client.get("/admin/web/monitoreddomain/add/").status_code, 403)
        self.assertTrue(MonitoredDomain.objects.filter(pk=domain.pk).exists())
