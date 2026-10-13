"""Docker reports are ordered by their ``collected_at``: an older report never replaces a newer inventory.

Heartbeats of one agent can overlap (a slow request, a retry, two workers), so
reports reach the server out of order. The inventory a report describes is only
as new as its ``collected_at``; the host row, locked by every report, holds the
``collected_at`` of the last report applied, and a report is applied only if it
is newer. A report that is not applied changes nothing: not a container, not the
host state, and not a timestamp that says how fresh the inventory is.

The agent's clock can step back, which would make its reports "older" than the
stored one until it catches up. An older report is therefore applied when no
report has been applied for longer than ``RECOVERY_AFTER`` *and* it is plausible
on the server's clock: collected within ``PLAUSIBLE_SKEW`` of the moment it is
received. Timestamps alone cannot tell a clock that stepped back from a replay,
so a report older than that is never recovered by time alone.
"""

import threading
from datetime import datetime, timedelta, timezone as dt_timezone

from django.db import connection, transaction
from django.test import TestCase, TransactionTestCase

from apps.agents.services import create_agent
from apps.core.validation import MAX_FUTURE_SKEW
from apps.infrastructure.docker_reports import (
    PLAUSIBLE_SKEW,
    RECOVERY_AFTER,
    apply_docker_report,
    validate_docker_payload,
)
from apps.infrastructure.models import DockerContainer, DockerHostState, Server

# Fixed, in the past (the validators only refuse the future), so nothing depends on the clock.
BASE = datetime(2025, 3, 1, 12, 0, tzinfo=dt_timezone.utc)
CREATED = BASE - timedelta(days=2)


def at(minutes=0.0, seconds=0.0, microseconds=0):
    return BASE + timedelta(minutes=minutes, seconds=seconds, microseconds=microseconds)


def container(index, **overrides):
    payload = {
        "container_id": f"{index:064x}",
        "name": f"c{index}",
        "image": "nginx:latest",
        "state": "running",
        "health": "none",
        "created_at": CREATED.isoformat(),
        "started_at": CREATED.isoformat(),
    }
    payload.update(overrides)
    return payload


def docker_report(containers=(), *, collected, status="available"):
    available = status == "available"
    return validate_docker_payload(
        {
            "version": 1,
            "available": available,
            "status": status,
            "collected_at": collected.isoformat(),
            "containers": list(containers) if available else [],
        }
    )


def stored_state(server):
    """Every column of the host row and of every container row of ``server``."""
    host = DockerHostState.objects.filter(server=server).values().first()
    rows = list(DockerContainer.objects.filter(server=server).order_by("container_id").values())
    return host, rows


class OrderingTests(TestCase):
    def setUp(self):
        self.server = Server.objects.create(name="order-host", hostname="order.local")
        # The newer report: collected at +10 minutes, received at +10 minutes.
        self.newer = docker_report([container(1), container(2, state="running", health="healthy")], collected=at(10))
        apply_docker_report(self.server, self.newer, received_at=at(10))
        self.before = stored_state(self.server)

    def apply(self, containers=(), *, collected, received, status="available"):
        return apply_docker_report(
            self.server, docker_report(containers, collected=collected, status=status), received_at=received
        )

    def assertUnchanged(self):
        self.assertEqual(stored_state(self.server), self.before)

    def test_an_older_report_does_not_replace_a_newer_inventory(self):
        result = self.apply([container(1), container(2)], collected=at(5), received=at(10, 30))
        self.assertUnchanged()
        self.assertFalse(result)

    def test_an_older_report_with_a_different_container_list_adds_and_removes_nothing(self):
        result = self.apply([container(3), container(4)], collected=at(9), received=at(11))
        self.assertUnchanged()
        rows = DockerContainer.objects.order_by("container_id")
        self.assertEqual([row.container_id for row in rows], [f"{1:064x}", f"{2:064x}"])
        self.assertTrue(all(row.present for row in rows))  # not marked absent by a list that omits them
        self.assertFalse(result)

    def test_an_older_empty_report_does_not_make_every_container_absent(self):
        result = self.apply([], collected=at(1), received=at(12))
        self.assertUnchanged()
        self.assertEqual(DockerContainer.objects.filter(present=True).count(), 2)
        self.assertFalse(result)

    def test_an_older_report_cannot_change_a_container_state(self):
        result = self.apply(
            [container(1, state="exited", health="unhealthy"), container(2, state="dead", health="none")],
            collected=at(9, 59),
            received=at(11),
        )
        self.assertUnchanged()
        row = DockerContainer.objects.get(container_id=f"{1:064x}")
        self.assertEqual((row.state, row.health), ("running", "none"))
        self.assertFalse(result)

    def test_an_older_report_that_says_docker_is_down_does_not_flip_the_host(self):
        result = self.apply(collected=at(8), received=at(11), status="unavailable")
        self.assertUnchanged()
        host = DockerHostState.objects.get()
        self.assertTrue(host.available)
        self.assertEqual(host.status, "available")
        self.assertFalse(result)

    def test_an_older_report_does_not_bring_a_container_list_back_after_an_outage(self):
        apply_docker_report(self.server, docker_report(collected=at(20), status="error"), received_at=at(20))
        before = stored_state(self.server)
        result = self.apply([container(7)], collected=at(15), received=at(21))
        self.assertEqual(stored_state(self.server), before)
        host = DockerHostState.objects.get()
        self.assertEqual((host.available, host.status), (False, "error"))
        self.assertFalse(DockerContainer.objects.filter(container_id=f"{7:064x}").exists())
        self.assertFalse(result)

    def test_equal_timestamps_are_a_duplicate_and_change_nothing(self):
        """The first report with a given ``collected_at`` stands; an equal one is a duplicate, whenever it arrives."""
        same = self.apply([container(1), container(9)], collected=at(10), received=at(10, 45))
        self.assertUnchanged()
        self.assertFalse(DockerContainer.objects.filter(container_id=f"{9:064x}").exists())
        self.assertFalse(same)
        # An exact replay does not make the inventory look fresher than it is either.
        replay = self.apply([container(1), container(2, health="healthy")], collected=at(10), received=at(30))
        self.assertUnchanged()
        self.assertEqual(DockerHostState.objects.get().received_at, at(10))
        self.assertFalse(replay)

    def test_a_rejected_report_leaves_every_freshness_timestamp_alone(self):
        host_before = DockerHostState.objects.get()
        self.apply([container(1, state="exited")], collected=at(2), received=at(40))
        host = DockerHostState.objects.get()
        self.assertEqual(host.received_at, host_before.received_at)
        self.assertEqual(host.collected_at, host_before.collected_at)
        self.assertEqual(host.last_discovered_at, host_before.last_discovered_at)
        for row in DockerContainer.objects.all():
            self.assertEqual((row.received_at, row.last_seen_at), (at(10), at(10)))

    def test_a_rejected_report_makes_no_container_eligible_for_removal(self):
        self.apply([], collected=at(1), received=at(60))
        self.assertFalse(DockerContainer.objects.filter(present=False).exists())

    def test_a_newer_report_applies_after_a_rejected_older_one(self):
        self.apply([container(3)], collected=at(5), received=at(11))
        self.assertUnchanged()
        result = self.apply([container(1, state="exited"), container(3)], collected=at(12), received=at(12))
        self.assertTrue(result)
        rows = {row.container_id: row for row in DockerContainer.objects.all()}
        self.assertEqual(rows[f"{1:064x}"].state, "exited")
        self.assertTrue(rows[f"{3:064x}"].present)
        gone = rows[f"{2:064x}"]
        self.assertFalse(gone.present)
        self.assertEqual(gone.last_seen_at, at(10))  # last seen in the previous successful discovery
        host = DockerHostState.objects.get()
        self.assertEqual((host.collected_at, host.received_at, host.last_discovered_at), (at(12), at(12), at(12)))

    def test_a_container_that_disappears_in_a_newer_snapshot_is_marked_absent(self):
        result = self.apply([container(2, health="healthy")], collected=at(10, microseconds=1), received=at(11))
        self.assertTrue(result)
        rows = {row.container_id: row for row in DockerContainer.objects.all()}
        self.assertFalse(rows[f"{1:064x}"].present)
        self.assertEqual(rows[f"{1:064x}"].last_seen_at, at(10))
        self.assertTrue(rows[f"{2:064x}"].present)

    def test_an_older_report_applies_when_it_is_the_first_the_host_ever_sent(self):
        other = Server.objects.create(name="first-host", hostname="first.local")
        result = apply_docker_report(other, docker_report([container(1)], collected=at(-60)), received_at=at(11))
        self.assertTrue(result)
        self.assertEqual(DockerContainer.objects.filter(server=other, present=True).count(), 1)


class RecoveryWindowTests(TestCase):
    def test_both_windows_are_the_clock_skew_allowance_of_the_validators_and_of_telemetry(self):
        """One allowance, five minutes: what ``parse_timestamp`` grants an agent clock ahead, and the
        time after which the telemetry snapshot gives way (``_upsert_snapshot``)."""
        self.assertEqual(MAX_FUTURE_SKEW, timedelta(minutes=5))
        self.assertEqual(RECOVERY_AFTER, MAX_FUTURE_SKEW)
        self.assertEqual(PLAUSIBLE_SKEW, MAX_FUTURE_SKEW)


class RecoveryTests(TestCase):
    """The agent's clock stepped back: its reports look older than the stored one.

    The agent's clock ran 4 minutes ahead of the server's when it stored its report
    (collected at +14, received at +10); it was then corrected to 4 minutes behind.
    """

    def setUp(self):
        self.server = Server.objects.create(name="clock-host", hostname="clock.local")
        apply_docker_report(self.server, docker_report([container(1)], collected=at(14)), received_at=at(10))
        self.after = at(10) + RECOVERY_AFTER  # the stored inventory is exactly this old at +15

    def apply(self, containers, *, collected, received):
        return apply_docker_report(self.server, docker_report(containers, collected=collected), received_at=received)

    def test_a_plausible_report_after_a_clock_rollback_recovers_the_inventory(self):
        received = self.after + timedelta(minutes=1)  # +16: nothing has been applied for six minutes
        self.assertTrue(self.apply([container(2)], collected=at(12), received=received))  # its clock reads 4 minutes behind
        host = DockerHostState.objects.get()
        self.assertEqual((host.collected_at, host.received_at, host.last_discovered_at), (at(12), received, received))
        rows = {row.container_id: row.present for row in DockerContainer.objects.all()}
        self.assertEqual(rows, {f"{1:064x}": False, f"{2:064x}": True})

    def test_after_recovery_the_new_timeline_orders_reports_again(self):
        received = self.after + timedelta(minutes=1)
        self.assertTrue(self.apply([container(2)], collected=at(12), received=received))
        self.assertTrue(self.apply([container(2), container(3)], collected=at(12, 30), received=received + timedelta(seconds=30)))
        after = stored_state(self.server)
        # An older report is a late one again: applied reports keep the recovery window closed.
        self.assertFalse(self.apply([container(9)], collected=at(12, 10), received=received + timedelta(seconds=40)))
        self.assertEqual(stored_state(self.server), after)

    def test_the_stored_inventory_is_kept_until_the_recovery_timeout_has_passed(self):
        before = stored_state(self.server)
        # Plausible, older, but the stored report is only 5 minutes old at +15: not "longer than" the timeout.
        self.assertFalse(self.apply([container(2)], collected=at(12), received=self.after))
        self.assertEqual(stored_state(self.server), before)
        self.assertTrue(self.apply([container(2)], collected=at(12), received=self.after + timedelta(microseconds=1)))

    def test_an_implausibly_old_report_after_the_timeout_is_rejected(self):
        received = self.after + timedelta(minutes=1)  # +16
        before = stored_state(self.server)
        too_old = received - PLAUSIBLE_SKEW - timedelta(microseconds=1)
        self.assertFalse(self.apply([container(2)], collected=too_old, received=received))
        self.assertEqual(stored_state(self.server), before)
        # Exactly at the bound it is still plausible.
        self.assertTrue(self.apply([container(2)], collected=received - PLAUSIBLE_SKEW, received=received))

    def test_a_report_stamped_too_far_ahead_is_not_plausible_either(self):
        """The window is two-sided: the same allowance the validators give an agent clock that runs ahead."""
        other = Server.objects.create(name="ahead", hostname="ahead.local")
        apply_docker_report(other, docker_report([container(1)], collected=at(40)), received_at=at(10))
        before = stored_state(other)
        received = at(16)  # the stored report is six minutes old and older than the stored stamp is at +40
        ahead = apply_docker_report(other, docker_report([container(2)], collected=received + PLAUSIBLE_SKEW + timedelta(microseconds=1)), received_at=received)
        self.assertFalse(ahead)
        self.assertEqual(stored_state(other), before)
        self.assertTrue(apply_docker_report(other, docker_report([container(2)], collected=received + PLAUSIBLE_SKEW), received_at=received))

    def test_a_delayed_old_report_after_the_recovery_timeout_is_rejected(self):
        """A report that is hours or minutes late is the same stale data it was when it was collected."""
        before = stored_state(self.server)
        for minutes_late in (6, 30, 600):
            received = at(10) + timedelta(minutes=minutes_late)
            self.assertFalse(self.apply([container(5)], collected=at(9), received=received), minutes_late)
        self.assertEqual(stored_state(self.server), before)
        host = DockerHostState.objects.get()
        self.assertEqual(host.received_at, at(10))  # nothing refreshed it

    def test_equal_timestamps_after_the_timeout_are_rejected_even_when_plausible(self):
        before = stored_state(self.server)
        received = self.after + timedelta(minutes=1)
        # collected_at equals the stored one, is plausible on the server's clock (2 minutes old), and the
        # stored report is six minutes old: a duplicate all the same.
        self.assertFalse(self.apply([container(2)], collected=at(14), received=received))
        self.assertEqual(stored_state(self.server), before)

    def test_a_newer_report_needs_no_recovery_however_late_it_is(self):
        received = at(10) + timedelta(hours=3)
        self.assertTrue(self.apply([container(2)], collected=at(14, microseconds=1), received=received))

    def test_a_rollback_beyond_the_window_waits_for_the_clock_to_catch_up(self):
        """Not distinguishable from a replay by timestamps: frozen until the agent's clock passes the stored time."""
        other = Server.objects.create(name="rolled-back", hostname="rolled.local")
        apply_docker_report(other, docker_report([container(1)], collected=at(120)), received_at=at(120))
        before = stored_state(other)
        for hours_later in (0.1, 1, 1.9):  # the clock stays two hours behind: never plausible, however long it lasts
            received = at(120) + timedelta(hours=hours_later)
            collected = received - timedelta(hours=2)
            self.assertFalse(apply_docker_report(other, docker_report([container(2)], collected=collected), received_at=received))
        self.assertEqual(stored_state(other), before)
        # Two hours on, the agent's clock has passed the stored time: strictly newer, applied.
        received = at(120) + timedelta(hours=2, minutes=1)
        self.assertTrue(apply_docker_report(other, docker_report([container(2)], collected=received - timedelta(hours=2)), received_at=received))

    def test_applied_reports_keep_the_window_closed_for_a_healthy_agent(self):
        other = Server.objects.create(name="healthy", hostname="healthy.local")
        apply_docker_report(other, docker_report([container(1)], collected=at(120)), received_at=at(120))
        for minute in range(121, 140):
            self.assertTrue(apply_docker_report(other, docker_report([container(1)], collected=at(minute)), received_at=at(minute)))
        # Late by a minute and plausible, but reports have been applied all along: an ordinary late report.
        late = docker_report([container(5)], collected=at(138))
        self.assertFalse(apply_docker_report(other, late, received_at=at(139, 30)))


class ConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.server = Server.objects.create(name="race-host", hostname="race.local")
        create_agent(server=self.server, name="race-agent")

    @staticmethod
    def wait_until(condition, timeout=10.0):
        """Poll without a fixed sleep: ``condition()`` becomes true or the test fails."""
        done = threading.Event()
        deadline = timeout
        while deadline > 0 and not condition():
            done.wait(0.01)
            deadline -= 0.01
        return condition()

    def blocked_on_a_row_lock(self):
        with connection.cursor() as cursor:
            # The statistics views are cached for the rest of a transaction: read a fresh one each time.
            cursor.execute("SELECT pg_stat_clear_snapshot()")
            cursor.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                "AND query ILIKE '%%infrastructure_dockerhoststate%%FOR UPDATE%%'"
            )
            return cursor.fetchone()[0] > 0

    def test_the_order_is_checked_under_the_lock_not_before_it(self):
        """An older report waits for the host lock; the newer one lands meanwhile; the older then finds it and stands down."""
        apply_docker_report(self.server, docker_report([container(1)], collected=at(5)), received_at=at(5))
        outcome = {}

        def older_report():
            try:
                outcome["applied"] = apply_docker_report(
                    Server.objects.get(pk=self.server.pk),
                    docker_report([container(9)], collected=at(6)),
                    received_at=at(11),
                )
            finally:
                connection.close()

        with transaction.atomic():
            DockerHostState.objects.select_for_update().get(server=self.server)  # this transaction holds the lock
            worker = threading.Thread(target=older_report)
            worker.start()
            self.assertTrue(self.wait_until(self.blocked_on_a_row_lock), "the older report never reached the lock")
            # While it waits, a newer report is applied and commits with the lock.
            DockerHostState.objects.filter(server=self.server).update(collected_at=at(10), received_at=at(10), last_discovered_at=at(10))
            DockerContainer.objects.filter(server=self.server).update(name="newer-state")
        worker.join(timeout=30)
        self.assertFalse(worker.is_alive())
        self.assertFalse(outcome["applied"])
        self.assertFalse(DockerContainer.objects.filter(container_id=f"{9:064x}").exists())
        self.assertEqual(DockerContainer.objects.get().name, "newer-state")
        host = DockerHostState.objects.get()
        self.assertEqual((host.collected_at, host.received_at), (at(10), at(10)))

    def run_concurrently(self, reports):
        barrier = threading.Barrier(len(reports))
        errors = []
        results = []

        def worker(docker, received):
            try:
                barrier.wait(timeout=10)
                results.append(apply_docker_report(Server.objects.get(pk=self.server.pk), docker, received_at=received))
            except Exception as exc:  # noqa: BLE001 - surfaced by the assertion
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker, args=item) for item in reports]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        # Every worker finished (none is stuck on a lock) and every one returned a verdict.
        self.assertEqual([thread for thread in threads if thread.is_alive()], [])
        self.assertEqual(errors, [])
        self.assertEqual(len(results), len(reports))
        self.assertTrue(all(isinstance(result, bool) for result in results), results)
        return results

    def test_concurrent_reports_end_in_the_state_of_the_newest_whatever_the_arrival_order(self):
        for attempt in range(6):
            DockerContainer.objects.all().delete()
            DockerHostState.objects.all().delete()
            minutes = [1, 2, 3, 4, 5, 6]
            reports = [
                (docker_report([container(index) for index in range(minute)], collected=at(minute)), at(20))
                for minute in minutes
            ]
            # A different thread start order each time; the newest is the one whose list is longest.
            reports = reports[attempt % len(reports):] + reports[: attempt % len(reports)]
            results = self.run_concurrently(reports)
            host = DockerHostState.objects.get()
            self.assertEqual(host.collected_at, at(6), attempt)
            present = {row.container_id for row in DockerContainer.objects.filter(present=True)}
            self.assertEqual(present, {f"{index:064x}" for index in range(6)}, attempt)
            self.assertTrue(any(results))  # at least the newest was applied
            # Nothing older than the newest left a mark: an applied report is never older than the one before it.
            self.assertEqual(host.received_at, at(20))

    def test_concurrent_first_reports_keep_the_newest(self):
        newest = docker_report([container(1), container(2)], collected=at(9))
        oldest = docker_report([container(5)], collected=at(3))
        for attempt in range(5):
            DockerContainer.objects.all().delete()
            DockerHostState.objects.all().delete()
            order = [(newest, at(10)), (oldest, at(10))]
            self.run_concurrently(order if attempt % 2 else order[::-1])
            self.assertEqual(DockerHostState.objects.get().collected_at, at(9), attempt)
            self.assertEqual(
                {row.container_id for row in DockerContainer.objects.filter(present=True)},
                {f"{1:064x}", f"{2:064x}"},
                attempt,
            )

    def test_concurrent_recovery_and_newer_report_end_in_the_newer_state(self):
        """A recovery-eligible older report and a newer one race: the newer state wins whichever lock order occurs."""
        for attempt in range(6):
            DockerContainer.objects.all().delete()
            DockerHostState.objects.all().delete()
            # The agent's clock ran ahead (stored +14, received +10), then stepped back.
            apply_docker_report(self.server, docker_report([container(1)], collected=at(14)), received_at=at(10))
            recovering = (docker_report([container(2)], collected=at(12)), at(16))  # plausible, older, stored is 6 minutes old
            newer = (docker_report([container(2), container(3)], collected=at(15, 30)), at(16, 1))
            self.run_concurrently([recovering, newer] if attempt % 2 else [newer, recovering])
            host = DockerHostState.objects.get()
            self.assertEqual(host.collected_at, at(15, 30), attempt)
            present = {row.container_id for row in DockerContainer.objects.filter(present=True)}
            self.assertEqual(present, {f"{2:064x}", f"{3:064x}"}, attempt)
            # The newer report was received last in server time: nothing the older one did can be the last word.
            self.assertEqual(host.received_at, at(16, 1), attempt)
