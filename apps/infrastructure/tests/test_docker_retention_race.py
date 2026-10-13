"""Docker retention and rediscovery must not corrupt each other.

``purge_absent_docker_containers`` selects the containers that are absent and
were last seen before the cutoff, then deletes them; a Docker report can list
one of those containers again in between. Whatever the interleaving, the end
state has to be the one a serial execution would give: a container the latest
applied report lists is present, exactly as reported; a container nothing has
rediscovered is deleted once it is eligible, and never sooner.

The interleavings are forced, not raced: one side is held at a chosen point
(after retention selected its candidates, or after ingestion read the rows it
is about to write) while the other side runs, then released. The assertions are
about the final state, so they hold for any locking scheme that keeps the two
consistent, and each side is bounded in time so that a lock that is never
released fails the test instead of hanging it.
"""

import threading
import time
from contextlib import contextmanager
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.db import OperationalError, connection
from django.db.models.query import QuerySet
from django.test import TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.console.tests.helpers import PINNED, make_user, signed_in_client
from apps.infrastructure.docker_reports import apply_docker_report
from apps.infrastructure.management.commands import purge_absent_docker_containers as purge_command
from apps.infrastructure.models import DockerContainer, DockerHostState, Server
from apps.infrastructure.tests.test_docker_ordering import container, docker_report
from apps.inventory.models import Customer, Site

DAYS = 30
HELD = 1.0  # how long the other side gets to run while one side is held at its chosen point
BOUND = 20  # the longest a cleanup may take to deal with a busy server
SHORT_LOCK_TIMEOUT_MS = 300  # stands in for the production five seconds where a test waits for it
LONG = 60  # no thread may take longer than this to finish


class Held:
    """Pauses one thread inside ``QuerySet.<method>`` for the DockerContainer model, once, until released."""

    def __init__(self, method):
        self.method = method
        self.reached = threading.Event()
        self.release = threading.Event()
        self.thread = None

    @contextmanager
    def install(self):
        original = getattr(QuerySet, self.method)
        held = self

        def wrapper(queryset, *args, **kwargs):
            if (
                threading.current_thread() is held.thread
                and queryset.model is DockerContainer
                and not held.reached.is_set()
            ):
                held.reached.set()
                held.release.wait(timeout=LONG)
            return original(queryset, *args, **kwargs)

        with patch.object(QuerySet, self.method, wrapper):
            yield


def wait_until(condition, timeout=10.0):
    """Poll ``condition`` without a fixed sleep: it becomes true within ``timeout`` seconds or this returns False."""
    pause, remaining = threading.Event(), timeout
    while remaining > 0 and not condition():
        pause.wait(0.01)
        remaining -= 0.01
    return condition()


def queued_on_a_host_lock():
    """How many sessions are waiting for a lock on a Docker host state row right now."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_stat_clear_snapshot()")  # the statistics views are cached for the rest of a transaction
        cursor.execute(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE %s",
            ["%infrastructure_dockerhoststate%FOR UPDATE%"],
        )
        return cursor.fetchone()[0]


class Workers:
    """Runs callables in threads (each with its own connection) and collects what they raise."""

    def __init__(self):
        self.errors = []
        self.threads = []

    def start(self, function, *args, hold=None):
        def run():
            try:
                function(*args)
            except Exception as exc:  # noqa: BLE001 - surfaced by the assertion
                self.errors.append(exc)
            finally:
                connection.close()

        thread = threading.Thread(target=run)
        if hold is not None:
            hold.thread = thread
        self.threads.append(thread)
        thread.start()
        return thread

    def finish(self, test):
        for thread in self.threads:
            thread.join(timeout=LONG)
        test.assertEqual([thread for thread in self.threads if thread.is_alive()], [], "a worker is stuck")
        test.assertEqual(self.errors, [], "a worker failed")


@override_settings(SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS=DAYS)
class RetentionRaceBase(TransactionTestCase):
    def setUp(self):
        self.now = timezone.now()
        self.server = Server.objects.create(name="race-host", hostname="race.local")

    def ago(self, days):
        return self.now - timedelta(days=days)

    def make_absent(self, server, *indexes, listed_days=60, dropped_days=45):
        """Containers listed by an old discovery and dropped by a later one: absent, last seen ``listed_days`` ago."""
        listed = [container(index) for index in indexes]
        apply_docker_report(server, docker_report(listed, collected=self.ago(listed_days)), received_at=self.ago(listed_days))
        apply_docker_report(server, docker_report([], collected=self.ago(dropped_days)), received_at=self.ago(dropped_days))

    def report_now(self, server, *containers, seconds_ago=1):
        """A discovery received now, collected just before: newer than everything stored."""
        collected = self.now - timedelta(seconds=seconds_ago)
        return apply_docker_report(server, docker_report(list(containers), collected=collected), received_at=self.now)

    def give_host_state(self, server=None):
        """The Docker state a server has once its first report was applied (for containers created directly)."""
        return DockerHostState.objects.get_or_create(
            server=server or self.server,
            defaults={"available": True, "status": "available", "collected_at": self.now, "received_at": self.now, "last_discovered_at": self.now},
        )[0]

    def purge(self, **options):
        output = StringIO()
        call_command("purge_absent_docker_containers", stdout=output, stderr=output, **options)
        return output.getvalue()

    def row(self, index, server=None):
        return DockerContainer.objects.filter(server=server or self.server, container_id=f"{index:064x}").first()

    def eligible(self):
        return DockerContainer.objects.filter(present=False, last_seen_at__lt=self.now - timedelta(days=DAYS)).count()


class RediscoveryDuringCleanupTests(RetentionRaceBase):
    def retention_selected_then_rediscovered(self, report_containers, *, seconds_ago=1):
        """Retention has chosen its candidates and is about to delete them; a report lists the container again."""
        workers, gate = Workers(), Held("delete")
        with gate.install():
            workers.start(self.purge, hold=gate)
            self.assertTrue(gate.reached.wait(10), "retention never reached its deletion")
            ingestion = workers.start(lambda: self.report_now(self.server, *report_containers, seconds_ago=seconds_ago))
            ingestion.join(timeout=HELD)  # finishes at once, or waits for a lock retention holds
            gate.release.set()
            workers.finish(self)

    def test_a_container_rediscovered_after_selection_survives_the_cleanup(self):
        self.make_absent(self.server, 1)
        self.assertEqual(self.eligible(), 1)
        self.retention_selected_then_rediscovered([container(1)])
        row = self.row(1)
        self.assertIsNotNone(row, "the container the latest report lists was deleted by the cleanup")
        self.assertTrue(row.present)

    def test_a_rediscovery_that_changes_the_container_is_kept_exactly_as_reported(self):
        self.make_absent(self.server, 1, 2)
        self.retention_selected_then_rediscovered([container(1, state="restarting", health="unhealthy", name="renamed")])
        row = self.row(1)
        self.assertIsNotNone(row)
        self.assertEqual((row.present, row.state, row.health, row.name), (True, "restarting", "unhealthy", "renamed"))
        self.assertEqual(row.last_seen_at, self.now)
        # The one the report did not list stays absent and, being eligible, is cleaned up.
        self.assertIsNone(self.row(2))

    def test_a_cleanup_that_runs_first_loses_nothing_the_report_lists(self):
        """The other serial order: deleted, then reported: the report creates it again."""
        self.make_absent(self.server, 1)
        self.purge()
        self.assertIsNone(self.row(1))
        self.report_now(self.server, container(1))
        self.assertTrue(self.row(1).present)

    def test_an_older_report_cannot_save_a_container_from_the_cleanup(self):
        """Under the ordering policy a rejected report writes nothing: it rediscovers nothing."""
        self.make_absent(self.server, 1)
        host_before = DockerHostState.objects.values().get()
        workers, gate = Workers(), Held("delete")
        outcome = {}
        with gate.install():
            workers.start(self.purge, hold=gate)
            self.assertTrue(gate.reached.wait(10))
            older = docker_report([container(1)], collected=self.ago(50))  # older than the stored discovery
            ingestion = workers.start(lambda: outcome.update(applied=apply_docker_report(self.server, older, received_at=self.now)))
            ingestion.join(timeout=HELD)
            gate.release.set()
            workers.finish(self)
        self.assertFalse(outcome["applied"])
        self.assertIsNone(self.row(1))  # still eligible, so cleaned up
        self.assertEqual(DockerHostState.objects.values().get(), host_before)

    def test_a_plausible_report_after_a_clock_rollback_rediscovers_like_any_applied_report(self):
        self.make_absent(self.server, 1)
        # The agent's clock had run ahead (stored stamp in the future, nothing applied for ten minutes), then stepped back.
        DockerHostState.objects.update(collected_at=self.now + timedelta(minutes=4), received_at=self.now - timedelta(minutes=10))
        self.assertTrue(self.report_now(self.server, container(1)))  # older than the stored stamp, plausible, recovered
        self.assertEqual(self.purge().count("Deleted 0"), 1)
        self.assertTrue(self.row(1).present)


class ConcurrentIngestionAndCleanupTests(RetentionRaceBase):
    def test_a_container_reported_while_the_cleanup_deletes_it_is_not_lost(self):
        """Ingestion has read the rows it is about to write; the cleanup deletes the eligible one meanwhile."""
        self.make_absent(self.server, 1)
        workers, gate = Workers(), Held("bulk_update")
        with gate.install():
            workers.start(lambda: self.report_now(self.server, container(1, state="exited")), hold=gate)
            self.assertTrue(gate.reached.wait(10), "ingestion never reached its update")
            cleanup = workers.start(self.purge)
            cleanup.join(timeout=HELD)  # finishes at once, or waits for a lock ingestion holds
            gate.release.set()
            workers.finish(self)
        row = self.row(1)
        self.assertIsNotNone(row, "a container the report lists was deleted under it")
        self.assertEqual((row.present, row.state), (True, "exited"))

    def test_ingestion_and_cleanup_of_different_servers_both_complete(self):
        """Ingestion for one server is held mid-write while the cleanup handles both: neither is lost, nothing is kept for good."""
        other = Server.objects.create(name="other-host", hostname="other.local")
        self.make_absent(self.server, 1)
        self.make_absent(other, 5, 6)
        workers, gate = Workers(), Held("bulk_update")
        with gate.install():
            workers.start(lambda: self.report_now(self.server, container(1)), hold=gate)
            self.assertTrue(gate.reached.wait(10))
            cleanup = workers.start(self.purge)
            cleanup.join(timeout=HELD)
            gate.release.set()
            workers.finish(self)
        self.assertIsNotNone(self.row(1), "a container the held ingestion reported was deleted under it")
        self.assertTrue(self.row(1).present)
        # The other server was never touched by that ingestion. Anything the first run had to leave
        # for later (a busy server) is cleaned up by the next one.
        self.purge()
        self.assertEqual((self.row(5, other), self.row(6, other)), (None, None))
        self.assertEqual(self.eligible(), 0)

    def test_the_cleanup_does_not_wait_for_ever_for_a_busy_server(self):
        """Timeout behaviour: an ingestion that stays in its transaction cannot make the cleanup hang or fail."""
        self.make_absent(self.server, 1)
        workers, gate = Workers(), Held("bulk_update")
        with gate.install(), patch.object(purge_command, "LOCK_TIMEOUT_MS", SHORT_LOCK_TIMEOUT_MS):
            workers.start(lambda: self.report_now(self.server, container(1)), hold=gate)
            self.assertTrue(gate.reached.wait(10))
            cleanup = workers.start(self.purge)
            cleanup.join(timeout=BOUND)
            self.assertFalse(cleanup.is_alive(), "the cleanup is waiting for a server that is busy")
            gate.release.set()
            workers.finish(self)  # also asserts that neither side failed (no deadlock, no lock timeout error)
        self.purge()
        self.assertEqual(self.eligible(), 0)

    def test_overlapping_cleanups_and_a_report_queue_on_the_host_lock_and_all_finish(self):
        """Two cleanups and a report really overlap on one server: one holds the lock, the others are known to be waiting."""
        self.make_absent(self.server, 1, 2, 3)
        outputs = {}
        workers, gate = Workers(), Held("delete")
        with gate.install():
            # The first cleanup is held inside its transaction: it has the host lock and has selected all three containers.
            workers.start(lambda: outputs.update(first=self.purge()), hold=gate)
            self.assertTrue(gate.reached.wait(10), "the first cleanup never reached its deletion")
            # The second cleanup and a report (listing 1 and 3, the latter changed) now have to wait for it.
            workers.start(lambda: outputs.update(second=self.purge()))
            workers.start(lambda: outputs.update(report=self.report_now(self.server, container(1), container(3, state="exited"))))
            self.assertTrue(
                wait_until(lambda: queued_on_a_host_lock() >= 2),
                "the second cleanup and the report did not both queue behind the first: no overlap was tested",
            )
            self.assertEqual(outputs, {})  # nobody has finished: the lock is still held
            gate.release.set()
            workers.finish(self)  # every worker ended and none failed (no deadlock, no lock timeout)
        self.assertEqual(set(outputs), {"first", "second", "report"}, "a worker returned no result")
        self.assertIn("Deleted 3 absent container(s)", outputs["first"])  # it decided under its lock, before the others
        self.assertIn("Deleted 0 absent container(s)", outputs["second"])  # nothing left for it, whichever of the two went first
        self.assertTrue(outputs["report"])  # the report was applied
        for name in ("first", "second"):
            self.assertNotIn("Deferred", outputs[name], name)  # all waited well inside the timeout
        self.assertEqual({row.container_id: row.state for row in DockerContainer.objects.all()},
                         {f"{1:064x}": "running", f"{3:064x}": "exited"})
        self.assertEqual(self.eligible(), 0)


class CleanupEligibilityTests(RetentionRaceBase):
    """The retention rules themselves, which a fix must leave exactly as they are."""

    def test_a_container_that_disappears_is_deleted_only_after_the_retention_period(self):
        self.make_absent(self.server, 1, listed_days=10, dropped_days=5)  # last seen 10 days ago: absent, not yet old enough
        self.assertEqual(self.purge().count("Deleted 0"), 1)
        self.assertTrue(DockerContainer.objects.filter(present=False).exists())
        self.assertIn("Deleted 1 absent container(s)", self.purge(days=9))  # a shorter period makes it eligible
        self.assertFalse(DockerContainer.objects.exists())

    def test_the_boundary_is_strict_and_judged_at_the_start_of_the_run(self):
        cutoff = self.now - timedelta(days=DAYS)
        self.give_host_state()
        for index, offset in enumerate((timedelta(microseconds=-1), timedelta(0), timedelta(microseconds=1)), start=1):
            DockerContainer.objects.create(
                server=self.server, container_id=f"{index:064x}", name=f"c{index}", image="img", state="exited",
                health="none", present=False, last_seen_at=cutoff + offset, received_at=cutoff + offset,
            )
        with patch("django.utils.timezone.now", return_value=self.now):
            self.purge()
        self.assertEqual(sorted(DockerContainer.objects.values_list("name", flat=True)), ["c2", "c3"])  # only the older one

    def test_present_containers_are_never_deleted_however_old(self):
        self.give_host_state()
        DockerContainer.objects.create(
            server=self.server, container_id=f"{1:064x}", name="old", image="img", state="running", health="none",
            present=True, last_seen_at=self.ago(5000), received_at=self.ago(5000),
        )
        self.purge()
        self.assertEqual(DockerContainer.objects.count(), 1)

    def test_repeated_cleanup_is_idempotent(self):
        self.make_absent(self.server, 1, 2)
        first, second = self.purge(), self.purge()
        self.assertIn("Deleted 2 absent container(s)", first)
        self.assertIn("Deleted 0 absent container(s)", second)
        self.assertFalse(DockerContainer.objects.exists())


class DeferralAndBoundsTests(RetentionRaceBase):
    """What the cleanup does when it cannot take the lock, and how its work is bounded."""

    def orphan_server(self, *indexes):
        """A server whose Docker host state is missing, with absent containers that are long past the retention."""
        orphan = Server.objects.create(name="no-host", hostname="no.local")
        for index in indexes:
            DockerContainer.objects.create(
                server=orphan, container_id=f"{index:064x}", name=f"c{index}", image="img", state="exited",
                health="none", present=False, last_seen_at=self.ago(60), received_at=self.ago(60),
            )
        return orphan

    def test_a_server_without_docker_host_state_is_deferred_and_never_deleted_from(self):
        orphan = self.orphan_server(1, 2)
        self.make_absent(self.server, 5)  # another server, with a host state, eligible
        with CaptureQueriesContext(connection) as queries:
            output = self.purge()
        deletes = [query["sql"] for query in queries if query["sql"].startswith("DELETE")]
        self.assertEqual(len(deletes), 1, "something was deleted without the lock")  # the other server's container only
        self.assertEqual(DockerContainer.objects.filter(server=orphan).count(), 2)
        self.assertIsNone(self.row(5))
        self.assertIn("Deleted 1 absent container(s)", output)
        self.assertIn("Deferred to a later run: 1 server(s)", output)
        self.assertNotIn("not touched", output)
        self.assertIn(f"no-host ({orphan.pk}): it has no Docker host state to lock", output)

    def test_a_dry_run_says_which_containers_it_would_leave_for_later(self):
        self.orphan_server(1, 2)
        self.make_absent(self.server, 5)
        output = self.purge(dry_run=True)
        self.assertIn("Would delete 1 absent container(s)", output)
        self.assertIn("2 more belong to a server without a Docker host state", output)
        self.assertEqual(DockerContainer.objects.count(), 3)

    def test_the_containers_of_a_deferred_server_are_cleaned_once_it_has_a_host_state(self):
        orphan = self.orphan_server(1, 2)
        self.purge()
        self.assertEqual(DockerContainer.objects.filter(server=orphan).count(), 2)
        # Its first report arrives: the host state exists, and the next run has the lock it needs.
        self.assertTrue(self.report_now(orphan))
        self.assertIn("Deleted 2 absent container(s)", self.purge())
        self.assertFalse(DockerContainer.objects.exists())

    def test_a_server_that_stays_busy_is_deferred_and_cleaned_on_the_next_run(self):
        other = Server.objects.create(name="other-host", hostname="other.local")
        self.make_absent(self.server, 1)
        self.make_absent(other, 5)
        workers, gate = Workers(), Held("bulk_create")
        with gate.install(), patch.object(purge_command, "LOCK_TIMEOUT_MS", SHORT_LOCK_TIMEOUT_MS):
            # A report for the first server is held inside its transaction, with the host lock (it adds a new container).
            workers.start(lambda: self.report_now(self.server, container(9)), hold=gate)
            self.assertTrue(gate.reached.wait(10))
            started = time.monotonic()
            output = self.purge()
            waited = time.monotonic() - started
            gate.release.set()
            workers.finish(self)
        self.assertLess(waited, BOUND)
        self.assertIn("Deleted 1 absent container(s)", output)  # the other server, which was not busy
        self.assertIn("Deferred to a later run: 1 server(s)", output)
        self.assertNotIn("not touched", output)
        self.assertIn(f"{self.server.name} ({self.server.pk}): its Docker host state stayed locked past the timeout", output)
        self.assertNotIn("by a Docker report", output)  # a report is one possible holder, not the explanation
        self.assertIsNotNone(self.row(1), "a busy server's container was deleted without the lock")
        self.assertIsNone(self.row(5, other))
        # The next run finds the server free and finishes the job; the report it waited for is intact.
        self.assertIn("Deleted 1 absent container(s)", self.purge())
        self.assertIsNone(self.row(1))
        self.assertTrue(self.row(9).present)

    def test_a_server_deferred_after_some_batches_keeps_them_deleted_and_says_so(self):
        self.make_absent(self.server, 1, 2, 3, 4, 5)
        original = QuerySet.delete
        holder = {}
        held, release = threading.Event(), threading.Event()

        def take_the_lock_afterwards():
            from django.db import transaction

            try:
                with transaction.atomic():
                    DockerHostState.objects.select_for_update().filter(server=self.server).first()
                    held.set()
                    release.wait(timeout=LONG)
            finally:
                connection.close()

        def delete_then_a_competitor_queues(queryset, *args, **kwargs):
            result = original(queryset, *args, **kwargs)
            if queryset.model is DockerContainer and "thread" not in holder:
                # Another transaction starts waiting for the host lock while the first batch still holds it:
                # it gets the lock as soon as that batch commits, so the second batch finds it taken.
                holder["thread"] = threading.Thread(target=take_the_lock_afterwards)
                holder["thread"].start()
                self.assertTrue(wait_until(lambda: queued_on_a_host_lock() >= 1), "the competitor never queued")
            return result

        with patch.object(QuerySet, "delete", delete_then_a_competitor_queues), patch.object(
            purge_command, "LOCK_TIMEOUT_MS", SHORT_LOCK_TIMEOUT_MS
        ):
            output = self.purge(batch_size=2)
        self.assertTrue(held.is_set())
        release.set()
        holder["thread"].join(timeout=LONG)
        self.assertFalse(holder["thread"].is_alive())
        # The first batch (two containers) was committed before the second could not be locked.
        self.assertIn("Deleted 2 absent container(s)", output)
        self.assertIn("in 1 batch(es)", output)
        self.assertIn("Deferred to a later run: 1 server(s)", output)
        self.assertIn("Batches already completed stay deleted", output)
        self.assertNotIn("not touched", output)
        self.assertEqual(self.eligible(), 3)
        # The rest waits for a later run, which takes it.
        self.assertIn("Deleted 3 absent container(s)", self.purge())
        self.assertEqual(self.eligible(), 0)

    def test_the_lock_timeout_is_five_seconds_and_only_a_lock_timeout_defers(self):
        self.assertEqual(purge_command.LOCK_TIMEOUT_MS, 5000)

        def failure(sqlstate):
            error = OperationalError("failed")
            error.__cause__ = type("Cause", (Exception,), {"sqlstate": sqlstate})()
            return error

        self.assertTrue(purge_command.is_lock_timeout(failure("55P03")))
        self.assertFalse(purge_command.is_lock_timeout(failure("08006")))  # a lost connection is not a busy server
        self.assertFalse(purge_command.is_lock_timeout(OperationalError("no cause")))
        self.make_absent(self.server, 1)
        with patch.object(QuerySet, "delete", side_effect=OperationalError("connection lost")):
            with self.assertRaises(OperationalError):
                self.purge()  # anything but a lock timeout is a failure of the run
        self.assertIsNotNone(self.row(1))

    def test_a_server_that_keeps_producing_candidates_cannot_keep_a_run_busy(self):
        self.make_absent(self.server, 1, 2, 3, 4, 5)
        created = []
        original = QuerySet.delete

        def delete_then_more_arrive(queryset, *args, **kwargs):
            result = original(queryset, *args, **kwargs)
            if queryset.model is DockerContainer and len(created) < 40:  # two more become eligible after every batch (up to a cap, so a run without a bound still ends)
                for _ in range(2):
                    index = 100 + len(created)
                    created.append(index)
                    DockerContainer.objects.create(
                        server=self.server, container_id=f"{index:064x}", name=f"c{index}", image="img", state="exited",
                        health="none", present=False, last_seen_at=self.ago(60), received_at=self.ago(60),
                    )
            return result

        with patch.object(QuerySet, "delete", delete_then_more_arrive):
            output = self.purge(batch_size=2)
        # Five candidates at the start: three batches of two, however many have arrived since.
        self.assertIn("Deleted 6 absent container(s)", output)
        self.assertIn("in 3 batch(es)", output)
        self.assertGreater(self.eligible(), 0)  # what arrived meanwhile waits for the next run ...
        self.purge()
        self.assertEqual(self.eligible(), 0)  # ... which takes it

    def test_every_deletion_is_decided_under_the_host_lock_in_its_own_transaction(self):
        self.make_absent(self.server, *range(1, 8))
        with CaptureQueriesContext(connection) as queries:
            self.purge(batch_size=3)
        statements = [" ".join(query["sql"].split()) for query in queries]
        transactions, outside, current = [], [], None
        for statement in statements:
            if statement == "BEGIN":
                current = []
            elif statement == "COMMIT":
                transactions.append(current)
                current = None
            else:
                (outside if current is None else current).append(statement)
        self.assertEqual(len(transactions), 3)  # 3 + 3 + 1 containers
        for batch in transactions:
            lock = next(i for i, s in enumerate(batch) if 'FROM "infrastructure_dockerhoststate"' in s and "FOR UPDATE" in s)
            select = next(i for i, s in enumerate(batch) if s.startswith("SELECT") and '"infrastructure_dockercontainer"' in s)
            delete = next(i for i, s in enumerate(batch) if s.startswith("DELETE"))
            self.assertLess(lock, select)  # the decision is made after the lock ...
            self.assertLess(select, delete)  # ... and the deletion follows it
            self.assertIn("lock_timeout", batch[0])  # set for this transaction only (set_config(..., true))
            self.assertIn('"present"', batch[delete])  # the eligibility is repeated in the DELETE
            self.assertIn('"last_seen_at" <', batch[delete])
        # Outside any transaction there is only the query that names the servers with candidates.
        self.assertEqual(len(outside), 1)
        self.assertIn("DISTINCT", outside[0])


@PINNED
class TenantIsolationTests(RetentionRaceBase):
    def test_the_console_shows_each_tenant_only_its_own_rediscovered_containers(self):
        acme, globex = Customer.objects.create(name="Acme"), Customer.objects.create(name="Globex")
        acme_site, globex_site = Site.objects.create(customer=acme, name="HQ"), Site.objects.create(customer=globex, name="Plant")
        mine = Server.objects.create(name="acme-web", hostname="acme.local", site=acme_site)
        theirs = Server.objects.create(name="globex-db", hostname="globex.local", site=globex_site)
        self.make_absent(mine, 1)
        self.make_absent(theirs, 1, 2)
        workers, gate = Workers(), Held("delete")
        with gate.install():
            workers.start(self.purge, hold=gate)
            self.assertTrue(gate.reached.wait(10))
            workers.start(lambda: self.report_now(mine, container(1))).join(timeout=HELD)
            gate.release.set()
            workers.finish(self)
        for user, server, expected in ((make_user("acme", customers=[acme]), mine, {"c1"}),
                                       (make_user("globex", customers=[globex]), theirs, set())):
            response = signed_in_client(user).get("/api/v1/console/containers/", {"server": str(server.pk)})
            self.assertEqual(response.status_code, 200)
            self.assertEqual({item["container"]["name"] for item in response.json()["items"]}, expected)
        other = signed_in_client(make_user("outsider", customers=[globex])).get("/api/v1/console/containers/", {"server": str(mine.pk)})
        self.assertEqual(other.json()["items"], [])  # another tenant's server looks empty
