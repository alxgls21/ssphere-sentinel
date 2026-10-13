"""Telemetry freshness: a reading is current only while its report is recent.

Liveness (the last heartbeat) and telemetry freshness (the last accepted
resource report) are separate facts. A heartbeat can go on for ever with the
telemetry section missing, rejected or dropped by the agent; the snapshot a
server keeps then describes the past. It stays available as the last known
reading (history, diagnostics) but must not drive the current health, the
status counts or the load sorting, and it is flagged as stale in the response.

Freshness is judged on the server's own clock (``ServerTelemetry.received_at``)
against the window liveness uses (``SENTINEL_OFFLINE_THRESHOLD``), inclusive.
"""

import itertools
import json
from datetime import datetime, timedelta

from django.test import override_settings
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.console.tests.helpers import ConsoleDataTestCase, make_server, make_user
from apps.console.tests.helpers import signed_in_client
from apps.console.tests.test_health import reference_server
from apps.console.tests.test_infra_performance import count_queries
from apps.infrastructure.models import Server, ServerTelemetry, ServerTelemetrySample
from apps.inventory.models import Customer, Site

WINDOW = 90  # SENTINEL_OFFLINE_THRESHOLD, pinned by the console tests
HOUR = 3600


class ListMixin:
    def ops(self):
        """A console user who may see every customer (created once per test)."""
        if not hasattr(self, "_ops"):
            self._ops = make_user("ops", all_customers=True)
        return self._ops

    def items(self, user=None, **params):
        response = self.get(user or self.ops(), "servers/", pageSize=200, **params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return {item["server"]["name"]: item for item in response.json()["items"]}

    def health(self, name):
        return self.items()[name]["health"]


class FreshnessBoundaryTests(ListMixin, ConsoleDataTestCase):
    def test_a_report_exactly_at_the_window_is_still_current(self):
        make_server("on-the-line", now=self.now, seen_ago=1, telemetry_ago=WINDOW, cpu=99)
        item = self.items()["on-the-line"]
        self.assertEqual(item["health"], "critical")
        self.assertFalse(item["server"]["telemetry"]["stale"])

    def test_a_report_one_microsecond_older_is_stale(self):
        make_server("just-late", now=self.now, seen_ago=1, telemetry_ago=WINDOW + 0.000001, cpu=99)
        item = self.items()["just-late"]
        self.assertEqual(item["health"], "unknown")
        self.assertTrue(item["server"]["telemetry"]["stale"])

    def test_the_window_is_the_offline_threshold(self):
        make_server("a-minute-old", now=self.now, seen_ago=1, telemetry_ago=61, cpu=99)
        self.assertEqual(self.health("a-minute-old"), "critical")  # inside 90 seconds
        with override_settings(SENTINEL_OFFLINE_THRESHOLD=60):
            self.assertEqual(self.items()["a-minute-old"]["health"], "unknown")
        with override_settings(SENTINEL_OFFLINE_THRESHOLD=300):
            self.assertEqual(self.items()["a-minute-old"]["health"], "critical")

    def test_the_boundary_does_not_depend_on_the_agents_clock(self):
        """``collectedAt`` is the agent's clock; only the arrival time on the server decides."""
        make_server("clock-behind", now=self.now, seen_ago=1, cpu=99)
        ServerTelemetry.objects.update(collected_at=self.now - timedelta(days=2))
        make_server("clock-ahead", now=self.now, seen_ago=1, cpu=5, telemetry_ago=HOUR)
        ServerTelemetry.objects.filter(server__name="clock-ahead").update(
            collected_at=self.now + timedelta(minutes=4)
        )
        items = self.items()
        self.assertEqual(items["clock-behind"]["health"], "critical")  # fresh arrival, old stamp
        self.assertEqual(items["clock-ahead"]["health"], "unknown")  # stale arrival, future stamp


class StaleTelemetryTests(ListMixin, ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        # The stale snapshots carry the largest values: if they leak into anything current, it shows.
        make_server("stale-hot", now=self.now, seen_ago=5, telemetry_ago=HOUR, cpu=99, memory=99, disk=99, uptime=10**9)
        make_server("stale-cool", now=self.now, seen_ago=5, telemetry_ago=HOUR, cpu=5, memory=5, disk=5, uptime=10**8)
        make_server("fresh-warm", now=self.now, seen_ago=5, cpu=85, memory=40, disk=40, uptime=500)
        make_server("fresh-cool", now=self.now, seen_ago=5, cpu=10, memory=20, disk=30, uptime=100)
        make_server("no-telemetry", now=self.now, seen_ago=5, cpu=None)
        make_server("offline", now=self.now, seen_ago=HOUR, cpu=97, memory=97, disk=97, uptime=10**7)
        make_server("never-reported", now=self.now, seen_ago=None, cpu=None)

    def test_a_stale_snapshot_no_longer_decides_the_health(self):
        healths = {name: item["health"] for name, item in self.items().items()}
        self.assertEqual(
            healths,
            {
                "stale-hot": "unknown",  # alive, but its only reading is an hour old: 99% says nothing about now
                "stale-cool": "unknown",  # an old calm reading does not make it healthy either
                "fresh-warm": "warning",
                "fresh-cool": "healthy",
                "no-telemetry": "unknown",  # alive, but it never reported a resource reading
                "offline": "critical",
                "never-reported": "unknown",
            },
        )

    def test_liveness_is_independent_of_freshness(self):
        statuses = {name: item["server"]["status"] for name, item in self.items().items()}
        self.assertEqual(statuses["stale-hot"], "online")
        self.assertEqual(statuses["stale-cool"], "online")
        self.assertEqual(statuses["no-telemetry"], "online")
        self.assertEqual(statuses["offline"], "offline")

    def test_the_status_counts_follow_the_same_rule(self):
        response = self.get(self.ops(), "servers/", pageSize=200)
        counts = response.json()["counts"]
        self.assertEqual(counts, {"critical": 1, "warning": 1, "unknown": 4, "idle": 0, "healthy": 1})
        self.assertEqual(response.json()["scopeTotal"], 7)

    def test_the_status_filters_return_exactly_those_servers(self):
        user = self.ops()
        expected = {
            "critical": ["offline"],
            "warning": ["fresh-warm"],
            "healthy": ["fresh-cool"],
            "unknown": ["never-reported", "no-telemetry", "stale-cool", "stale-hot"],
        }
        for status, names in expected.items():
            response = self.get(user, "servers/", status=status, sort="name", dir="asc", pageSize=200)
            self.assertEqual(self.names(response), sorted(names), status)
            self.assertEqual(response.json()["page"]["total"], len(names))

    def test_load_sorting_only_ranks_current_readings(self):
        user = self.ops()
        for column in ("cpu", "memory", "disk", "uptime"):
            for direction, current in (("desc", ["fresh-warm", "fresh-cool"]), ("asc", ["fresh-cool", "fresh-warm"])):
                names = self.names(self.get(user, "servers/", sort=column, dir=direction, pageSize=200))
                self.assertEqual(names[:2], current, (column, direction))
                # No current reading (stale, missing, offline, never reported): last, in name order.
                self.assertEqual(names[2:], sorted(names[2:]), (column, direction))

    def test_the_detail_view_agrees_with_the_list(self):
        user = self.ops()
        listed = self.items()
        for name in ("stale-hot", "stale-cool", "fresh-warm", "no-telemetry", "offline"):
            server = Server.objects.get(name=name)
            detail = self.get(user, f"servers/{server.pk}/").json()["item"]
            self.assertEqual(detail["health"], listed[name]["health"], name)
            self.assertEqual(detail["server"]["telemetry"], listed[name]["server"]["telemetry"], name)

    def test_the_last_known_reading_is_kept_and_flagged(self):
        telemetry = self.items()["stale-hot"]["server"]["telemetry"]
        self.assertEqual(telemetry["cpuPercent"], 99.0)
        self.assertEqual(telemetry["uptimeSeconds"], 10**9)
        self.assertTrue(telemetry["stale"])
        # The age is derivable from the payload: generatedAt - receivedAt.
        generated = timezone.now()
        arrival = datetime.fromisoformat(telemetry["receivedAt"].replace("Z", "+00:00"))
        self.assertLess(abs((generated - arrival) - timedelta(seconds=HOUR)), timedelta(milliseconds=1))  # iso() has ms precision
        self.assertFalse(self.items()["fresh-cool"]["server"]["telemetry"]["stale"])

    def test_a_server_without_a_snapshot_has_nothing_to_flag(self):
        self.assertIsNone(self.items()["no-telemetry"]["server"]["telemetry"])
        self.assertIsNone(self.items()["never-reported"]["server"]["telemetry"])

    def test_a_stored_warning_is_not_hidden_by_stale_telemetry(self):
        make_server("warned", now=self.now, seen_ago=5, telemetry_ago=HOUR, cpu=5, stored_status=Server.Status.WARNING)
        item = self.items()["warned"]
        self.assertEqual((item["server"]["status"], item["health"]), ("warning", "warning"))

    def test_history_is_untouched(self):
        """Stale readings leave the series endpoint (and the stored snapshot) alone."""
        server = Server.objects.get(name="stale-hot")
        ServerTelemetrySample.objects.create(
            server=server,
            sampled_at=self.now - timedelta(hours=2),
            cpu_percent=99.0,
            memory_percent=99.0,
            disk_percent=99.0,
        )
        self.assertEqual(ServerTelemetry.objects.get(server=server).cpu_percent, 99.0)
        self.assertEqual(ServerTelemetrySample.objects.filter(server=server).count(), 1)
        response = self.get(self.ops(), f"servers/{server.pk}/series/", range="6h")
        self.assertEqual(response.status_code, 200)
        self.assertIn(99.0, response.json()["cpu"])


class HeartbeatPathTests(ListMixin, ConsoleDataTestCase):
    """The agent's own endpoint, with the clock moving: liveness goes on, telemetry stops."""

    def setUp(self):
        super().setUp()
        self.server = Server.objects.create(name="agent-host", hostname="agent-host.internal")
        _, self.token = create_agent(server=self.server, name="agent")
        self.url = reverse("agent-heartbeat")
        self.start = self.now

    def at(self, seconds):
        timezone.now.return_value = self.start + timedelta(seconds=seconds)

    def heartbeat(self, seconds, body=None, *, raw=None, content_type="application/json"):
        self.at(seconds)
        data = raw if raw is not None else (json.dumps(body) if body is not None else "")
        response = self.client.post(
            self.url, data=data, content_type=content_type, HTTP_AUTHORIZATION=f"Bearer {self.token}"
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def row(self, seconds):
        self.at(seconds)
        return self.items()["agent-host"]

    def reports_stop(self, attempts):
        """Heartbeats every 30 seconds from 30 s on, each ``attempts`` entry saying what the telemetry part was."""
        for index, attempt in enumerate(attempts, start=1):
            self.heartbeat(30 * index, **attempt)

    def test_a_heartbeat_without_telemetry_does_not_keep_an_old_reading_current(self):
        self.heartbeat(0, {"telemetry": valid_telemetry(cpu_percent=99.0, collected_at=self.start.isoformat())})
        self.assertEqual(self.row(10)["health"], "critical")
        self.reports_stop([{"body": {}}, {"body": {}}, {"body": {}}])  # 30, 60, 90 s: still inside the window
        self.assertEqual(self.row(90)["health"], "critical")
        self.heartbeat(120, {})
        item = self.row(120)
        self.assertEqual(item["server"]["status"], "online")  # the agent is alive ...
        self.assertEqual(item["health"], "unknown")  # ... but says nothing about its resources
        self.assertTrue(item["server"]["telemetry"]["stale"])
        self.assertEqual(item["server"]["telemetry"]["cpuPercent"], 99.0)  # last known, kept

    def test_rejected_telemetry_does_not_refresh_the_reading(self):
        self.heartbeat(0, {"telemetry": valid_telemetry(cpu_percent=99.0, collected_at=self.start.isoformat())})
        for seconds, telemetry in ((30, {"version": 99}), (60, "garbage"), (90, {"version": 1, "cpu_percent": 500})):
            answer = self.heartbeat(seconds, {"telemetry": telemetry})
            self.assertEqual(answer["telemetry"], "rejected")
        answer = self.heartbeat(120, {"telemetry": {"version": 99}})
        self.assertEqual(answer["telemetry"], "rejected")
        item = self.row(120)
        self.assertEqual((item["server"]["status"], item["health"]), ("online", "unknown"))
        self.assertTrue(item["server"]["telemetry"]["stale"])

    def test_a_malformed_body_does_not_refresh_the_reading_either(self):
        self.heartbeat(0, {"telemetry": valid_telemetry(cpu_percent=99.0, collected_at=self.start.isoformat())})
        for seconds in (30, 60, 91):
            self.heartbeat(seconds, raw="{not json")
        self.assertEqual(self.row(91)["health"], "unknown")

    def test_an_accepted_report_makes_the_reading_current_again(self):
        self.heartbeat(0, {"telemetry": valid_telemetry(cpu_percent=99.0, collected_at=self.start.isoformat())})
        self.heartbeat(100, {})
        self.assertEqual(self.row(100)["health"], "unknown")
        later = (self.start + timedelta(seconds=130)).isoformat()
        self.assertEqual(self.heartbeat(130, {"telemetry": valid_telemetry(cpu_percent=10.0, collected_at=later)})["telemetry"], "accepted")
        item = self.row(130)
        self.assertEqual(item["health"], "healthy")
        self.assertFalse(item["server"]["telemetry"]["stale"])
        self.assertEqual(item["server"]["telemetry"]["cpuPercent"], 10.0)

    def test_the_last_known_snapshot_stays_in_the_database(self):
        self.heartbeat(0, {"telemetry": valid_telemetry(cpu_percent=99.0, collected_at=self.start.isoformat())})
        self.heartbeat(500, {})
        self.assertEqual(ServerTelemetry.objects.get(server=self.server).cpu_percent, 99.0)
        self.assertEqual(ServerTelemetrySample.objects.filter(server=self.server).count(), 1)

    def test_a_delayed_report_that_does_not_replace_the_snapshot_is_not_a_refresh(self):
        newer = (self.start + timedelta(seconds=10)).isoformat()
        older = (self.start - timedelta(seconds=50)).isoformat()
        self.heartbeat(10, {"telemetry": valid_telemetry(cpu_percent=99.0, collected_at=newer)})
        self.heartbeat(120, {"telemetry": valid_telemetry(cpu_percent=1.0, collected_at=older)})  # out of order
        item = self.row(120)
        # Accepted, but the snapshot kept the newer reading, which is now 110 seconds old.
        self.assertEqual(item["server"]["telemetry"]["cpuPercent"], 99.0)
        self.assertTrue(item["server"]["telemetry"]["stale"])
        self.assertEqual(item["health"], "unknown")


class ScopeTests(ConsoleDataTestCase):
    def test_counts_and_health_are_computed_inside_the_users_scope(self):
        acme = Customer.objects.create(name="Acme")
        globex = Customer.objects.create(name="Globex")
        hq = Site.objects.create(customer=acme, name="HQ")
        plant = Site.objects.create(customer=globex, name="Plant")
        make_server("acme-stale", now=self.now, site=hq, seen_ago=5, telemetry_ago=HOUR, cpu=99)
        make_server("acme-fresh", now=self.now, site=hq, seen_ago=5, cpu=99)
        make_server("globex-stale", now=self.now, site=plant, seen_ago=5, telemetry_ago=HOUR, cpu=99)
        make_server("globex-stale-2", now=self.now, site=plant, seen_ago=5, telemetry_ago=HOUR, cpu=99)
        make_server("private", now=self.now, seen_ago=5, telemetry_ago=HOUR, cpu=99)  # no site: all-access only
        user = make_user("acme-ops", sites=[hq])
        body = self.get(user, "servers/", pageSize=200).json()
        self.assertEqual(sorted(item["server"]["name"] for item in body["items"]), ["acme-fresh", "acme-stale"])
        self.assertEqual(body["counts"], {"critical": 1, "warning": 0, "unknown": 1, "idle": 0, "healthy": 0})
        self.assertEqual(body["scopeTotal"], 2)
        # A server of another customer is 404 whatever its freshness.
        hidden = Server.objects.get(name="globex-stale")
        self.assertEqual(self.get(user, f"servers/{hidden.pk}/").status_code, 404)


SEEN = (5, 90, 91)  # the last heartbeat, seconds ago: live, on the line, offline
STORED = ("online", "warning")
READINGS = (None, (10, 10, 10), (5, 94.5, 5), (100, 100, 100))  # (cpu, memory, disk); None: never sent
AGES = (0, 60, 90, 90.000001, 91, 100_000)  # how long ago the reading arrived, seconds


class FreshnessGridTests(ListMixin, ConsoleDataTestCase):
    """Every combination of heartbeat age, stored status, reading and reading age, judged a second way."""

    def build_grid(self):
        grid = {}
        for index, (seen, stored, reading, age) in enumerate(itertools.product(SEEN, STORED, READINGS, AGES)):
            if reading is None and age != AGES[0]:
                continue  # without a reading there is no age to vary
            name = f"srv-{index:03d}"
            cpu, memory, disk = reading if reading else (None, 20.0, 30.0)
            make_server(name, now=self.now, seen_ago=seen, stored_status=stored, telemetry_ago=age, cpu=cpu, memory=memory, disk=disk)
            grid[name] = (seen, stored, reading, age)
        self.assertLessEqual(len(grid), 200)  # one page holds the whole grid
        return grid

    @staticmethod
    def expected(case):
        seen, stored, reading, age = case
        return reference_server(seen, stored, reading, telemetry_ago=age)

    @staticmethod
    def is_current(case):
        seen, _stored, reading, age = case
        return reading is not None and seen <= WINDOW and age <= WINDOW

    def test_every_combination_agrees_with_the_reference(self):
        grid = self.build_grid()
        items = self.items()
        self.assertEqual(len(items), len(grid))
        counts = {key: 0 for key in ("critical", "warning", "unknown", "idle", "healthy")}
        for name, case in grid.items():
            status, health = self.expected(case)
            self.assertEqual((items[name]["server"]["status"], items[name]["health"]), (status, health), (name, case))
            counts[health] += 1
        response = self.get(self.ops(), "servers/", pageSize=200)
        self.assertEqual(response.json()["counts"], counts)
        # Whatever the health, the reading is flagged by its own age.
        for name, (_seen, _stored, reading, age) in grid.items():
            telemetry = items[name]["server"]["telemetry"]
            if reading is None:
                self.assertIsNone(telemetry, name)
            else:
                self.assertEqual(telemetry["stale"], age > WINDOW, (name, age))

    def test_the_status_filters_agree_with_the_reference(self):
        grid = self.build_grid()
        for health in ("critical", "warning", "unknown", "healthy"):
            expected = sorted(name for name, case in grid.items() if self.expected(case)[1] == health)
            response = self.get(self.ops(), "servers/", status=health, sort="name", dir="asc", pageSize=200)
            self.assertEqual(self.names(response), expected, health)

    def test_load_sorting_ranks_exactly_the_current_readings(self):
        grid = self.build_grid()
        for sort, position in (("cpu", 0), ("memory", 1), ("disk", 2)):
            for direction in ("asc", "desc"):
                current = sorted(
                    (name for name, case in grid.items() if self.is_current(case)),
                    key=lambda name: (grid[name][2][position] * (-1 if direction == "desc" else 1), name),
                )
                rest = sorted(name for name, case in grid.items() if not self.is_current(case))
                response = self.get(self.ops(), "servers/", sort=sort, dir=direction, pageSize=200)
                self.assertEqual(self.names(response), current + rest, (sort, direction))

    def test_the_detail_view_agrees_with_the_list(self):
        grid = self.build_grid()
        listed = self.items()
        by_name = {server.name: server for server in Server.objects.all()}
        for name in list(grid)[:: max(1, len(grid) // 25)]:
            detail = self.get(self.ops(), f"servers/{by_name[name].pk}/").json()["item"]
            self.assertEqual(detail["health"], listed[name]["health"], name)
            self.assertEqual(detail["server"]["telemetry"], listed[name]["server"]["telemetry"], name)


class QueryCountTests(ConsoleDataTestCase):
    def test_freshness_costs_no_extra_queries(self):
        """Fresh, stale and missing readings are told apart inside the one query that reads the rows."""
        user = make_user("ops", all_customers=True)
        client = signed_in_client(user)
        paths = ["servers/", "servers/?sort=cpu", "servers/?status=healthy"]  # each has rows before and after

        def measure():
            return {path: count_queries(client, path) for path in paths}

        for index in range(6):
            make_server(f"fresh-{index}", now=self.now, seen_ago=5, cpu=10 + index)
        all_fresh = measure()
        for index in range(6):
            make_server(f"stale-{index}", now=self.now, seen_ago=5, telemetry_ago=HOUR, cpu=50 + index)
            make_server(f"empty-{index}", now=self.now, seen_ago=5, cpu=None)
        self.assertEqual(measure(), all_fresh)
        detail = Server.objects.get(name="stale-0")
        self.assertEqual(count_queries(client, f"servers/{detail.pk}/"), count_queries(client, f"servers/{Server.objects.get(name='fresh-0').pk}/"))
