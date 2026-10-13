"""Health rules, checked against a straight transcription of the UI's own (``frontend/src/lib/status.ts``).

The database computes health (``apps.console.health``); these tests compute it
a second, independent way, in Python, from the same inputs, over a grid that
includes every boundary, and require the two to agree for every server and
container, in the list, in the detail and in the filters.
"""

import itertools
import math
from datetime import timedelta

from django.test import override_settings

from apps.console.tests.helpers import (
    ConsoleDataTestCase,
    make_container,
    make_docker_host,
    make_server,
    make_user,
)
from apps.infrastructure.liveness import evaluate_effective_status
from apps.infrastructure.models import DockerContainer, Server

OFFLINE_AFTER = 90


def js_round(value: float) -> int:
    """``Math.round``: halves go up (Python's ``round`` goes to even)."""
    return math.floor(value + 0.5)


def reference_server(seen_ago, stored, telemetry, *, warn=80, crit=95):
    """``(status, health)`` as ``serverHealthWithResources(serverStatus(...))`` decides them."""
    if seen_ago is None:
        status = "unknown"
    elif seen_ago > OFFLINE_AFTER:
        status = "offline"
    else:
        status = "warning" if stored == "warning" else "online"
    base = {"online": "healthy", "warning": "warning", "offline": "critical", "unknown": "unknown"}[status]
    if base in ("critical", "unknown") or telemetry is None:
        return status, base
    levels = [js_round(value) for value in telemetry]
    if any(level >= crit for level in levels):
        return status, "critical"
    if any(level >= warn for level in levels) or base == "warning":
        return status, "warning"
    return status, "healthy"


def reference_container(state, health, observable):
    """``containerHealth`` of the (state, health) the UI is shown."""
    if not observable:
        state, health = "unknown", "unknown"
    if state == "dead":
        return "critical"
    if state == "restarting":
        return "warning"
    if state == "running":
        return {"unhealthy": "critical", "starting": "idle"}.get(health, "healthy")
    if state in ("exited", "created", "paused"):
        return "idle"
    return "unknown"


SEEN = (None, 5, 89, 90, 91, 100_000)
STORED = ("online", "warning", "offline", "unknown")
TELEMETRY = (
    None,
    (10, 10, 10),
    (79.49, 5, 5),
    (79.5, 5, 5),
    (5, 94.49, 5),
    (5, 94.5, 5),
    (5, 5, 95),
    (100, 100, 100),
    (0, 0, 0),
)


class ServerHealthTests(ConsoleDataTestCase):
    def build_grid(self):
        grid = {}
        for index, (seen, stored, telemetry) in enumerate(itertools.product(SEEN, STORED, TELEMETRY)):
            if seen is None and telemetry is not None:
                continue  # a server that never reported has no telemetry
            name = f"srv-{index:03d}"
            cpu, memory, disk = telemetry if telemetry else (None, 20.0, 30.0)
            make_server(name, now=self.now, seen_ago=seen, stored_status=stored, cpu=cpu, memory=memory, disk=disk)
            grid[name] = (seen, stored, telemetry)
        return grid

    def test_every_combination_agrees_with_the_reference(self):
        grid = self.build_grid()
        user = make_user("ops", all_customers=True)
        response = self.get(user, "servers/", pageSize=200, sort="name", dir="asc")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["page"]["total"], len(grid))
        self.assertLessEqual(len(grid), 200)  # one page holds the whole grid
        counts = {key: 0 for key in ("critical", "warning", "unknown", "idle", "healthy")}
        for item in body["items"]:
            name = item["server"]["name"]
            expected_status, expected_health = reference_server(*grid[name])
            self.assertEqual((item["server"]["status"], item["health"]), (expected_status, expected_health), (name, grid[name]))
            counts[expected_health] += 1
        self.assertEqual(body["counts"], counts)

    def test_the_status_filter_returns_exactly_the_servers_of_that_health(self):
        grid = self.build_grid()
        user = make_user("ops", all_customers=True)
        for health in ("critical", "warning", "unknown", "healthy"):
            expected = sorted(name for name, args in grid.items() if reference_server(*args)[1] == health)
            response = self.get(user, "servers/", status=health, pageSize=200, sort="name", dir="asc")
            self.assertEqual(self.names(response), expected, health)
            self.assertEqual(response.json()["page"]["total"], len(expected))

    def test_the_detail_view_agrees_with_the_list(self):
        grid = self.build_grid()
        user = make_user("ops", all_customers=True)
        by_name = {s.name: s for s in Server.objects.all()}
        sample = list(grid)[:: len(grid) // 12]  # spread over every kind of server in the grid
        self.assertGreaterEqual(len(sample), 12)
        for name in sample:
            body = self.get(user, f"servers/{by_name[name].pk}/").json()
            expected_status, expected_health = reference_server(*grid[name])
            self.assertEqual((body["item"]["server"]["status"], body["item"]["health"]), (expected_status, expected_health))

    def test_the_status_is_the_same_as_the_ones_the_server_model_computes(self):
        """Liveness must not drift from ``apps.infrastructure.liveness`` (the heartbeat/admin rule)."""
        self.build_grid()
        user = make_user("ops", all_customers=True)
        body = self.get(user, "servers/", pageSize=200).json()
        stored = {server.name: server for server in Server.objects.all()}
        for item in body["items"]:
            model = evaluate_effective_status(stored[item["server"]["name"]], now=self.now, threshold_seconds=OFFLINE_AFTER)
            expected = "warning" if model == "online" and stored[item["server"]["name"]].status == "warning" else model
            self.assertEqual(item["server"]["status"], expected)

    def test_the_offline_boundary_is_inclusive_like_the_liveness_rule(self):
        make_server("on-the-line", now=self.now, seen_ago=OFFLINE_AFTER)
        make_server("just-late", now=self.now, seen_ago=OFFLINE_AFTER)
        late = Server.objects.get(name="just-late")
        late.last_seen_at -= timedelta(microseconds=1)
        late.save(update_fields=["last_seen_at"])
        statuses = {
            item["server"]["name"]: item["server"]["status"]
            for item in self.get(make_user("ops", all_customers=True), "servers/").json()["items"]
        }
        self.assertEqual(statuses, {"on-the-line": "online", "just-late": "offline"})

    def test_a_server_not_yet_late_still_reports_its_load_when_sorted(self):
        """Sorting by load treats a server exactly at the offline threshold as reporting, like its status."""
        make_server("edge", now=self.now, seen_ago=OFFLINE_AFTER, cpu=50)
        make_server("late", now=self.now, seen_ago=OFFLINE_AFTER + 0.000001, cpu=99)
        make_server("fresh", now=self.now, seen_ago=1, cpu=10)
        user = make_user("ops", all_customers=True)
        for column in ("cpu", "memory", "disk", "uptime"):
            names = self.names(self.get(user, "servers/", sort=column, dir="desc"))
            self.assertEqual(names[-1], "late", column)  # not reporting: last, whatever its value
            self.assertEqual(set(names[:2]), {"edge", "fresh"})
        self.assertEqual(self.names(self.get(user, "servers/", sort="cpu", dir="desc")), ["edge", "fresh", "late"])

    def test_the_thresholds_come_from_the_settings(self):
        make_server("a", now=self.now, cpu=70)
        make_server("b", now=self.now, cpu=90)
        make_server("c", now=self.now, cpu=50)
        user = make_user("ops", all_customers=True)
        with override_settings(SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT=60, SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT=85):
            healths = {i["server"]["name"]: i["health"] for i in self.get(user, "servers/").json()["items"]}
        self.assertEqual(healths, {"a": "warning", "b": "critical", "c": "healthy"})

    def test_each_resource_alone_can_raise_the_status(self):
        make_server("cpu-hot", now=self.now, cpu=96, memory=1, disk=1)
        make_server("mem-hot", now=self.now, cpu=1, memory=96, disk=1)
        make_server("disk-hot", now=self.now, cpu=1, memory=1, disk=96)
        make_server("disk-warm", now=self.now, cpu=1, memory=1, disk=85)
        healths = {
            i["server"]["name"]: i["health"]
            for i in self.get(make_user("ops", all_customers=True), "servers/").json()["items"]
        }
        self.assertEqual(healths, {"cpu-hot": "critical", "mem-hot": "critical", "disk-hot": "critical", "disk-warm": "warning"})


class ContainerHealthTests(ConsoleDataTestCase):
    def build_grid(self):
        """One server per observability case, each running every (state, health)."""
        cases = {
            "live": dict(seen_ago=5, docker=True),
            "docker-unavailable": dict(seen_ago=5, docker=False),
            "host-silent": dict(seen_ago=500, docker=True),
            "never-reported-docker": dict(seen_ago=None, docker=True),
            "no-docker-state": dict(seen_ago=5, docker=None),
            # The heartbeat goes on, but the Docker section stopped arriving (rejected, or the agent dropped Docker).
            "docker-report-stale": dict(seen_ago=5, docker=True, received_ago=2 * 86_400),
            # Both cutoffs are inclusive, like the server's own liveness rule.
            "both-on-the-line": dict(seen_ago=OFFLINE_AFTER, docker=True, received_ago=OFFLINE_AFTER),
            "server-just-late": dict(seen_ago=OFFLINE_AFTER + 0.000001, docker=True, received_ago=0),
            "docker-just-late": dict(seen_ago=0, docker=True, received_ago=OFFLINE_AFTER + 0.000001),
        }
        grid = {}
        for label, case in cases.items():
            server = make_server(label, now=self.now, seen_ago=case["seen_ago"], cpu=None)
            received_ago = case.get("received_ago", 0)
            if case["docker"] is not None:
                make_docker_host(server, now=self.now, available=case["docker"], received_ago=received_ago)
            observable = (
                case["seen_ago"] is not None
                and case["seen_ago"] <= OFFLINE_AFTER
                and case["docker"] is True
                and received_ago <= OFFLINE_AFTER
            )
            for state, health in itertools.product(DockerContainer.State.values, DockerContainer.Health.values):
                name = f"{label}:{state}:{health}"
                make_container(server, name, now=self.now, state=state, health=health)
                grid[name] = (state, health, observable)
        return grid

    def test_every_combination_agrees_with_the_reference(self):
        grid = self.build_grid()
        user = make_user("ops", all_customers=True)
        seen = {}
        page = 1
        while True:
            body = self.get(user, "containers/", pageSize=200, page=page).json()
            for item in body["items"]:
                seen[item["container"]["name"]] = item
            if page >= body["page"]["pages"]:
                break
            page += 1
        self.assertEqual(set(seen), set(grid))
        counts = {key: 0 for key in ("critical", "warning", "unknown", "idle", "healthy")}
        for name, (state, health, observable) in grid.items():
            expected = reference_container(state, health, observable)
            item = seen[name]
            self.assertEqual(item["status"], expected, name)
            counts[expected] += 1
            if observable:
                self.assertEqual((item["container"]["state"], item["container"]["health"]), (state, health))
            else:
                # Last-known is not current: the stored state is not shown as if it were.
                self.assertEqual((item["container"]["state"], item["container"]["health"]), ("unknown", "unknown"), name)
        self.assertEqual(body["counts"], counts)

    def test_the_status_filter_and_the_server_counts_agree(self):
        grid = self.build_grid()
        user = make_user("ops", all_customers=True)
        for status in ("critical", "warning", "unknown", "idle", "healthy"):
            expected = {n for n, (s, h, o) in grid.items() if reference_container(s, h, o) == status}
            got = set()
            page = 1
            while True:
                body = self.get(user, "containers/", status=status, pageSize=200, page=page).json()
                got |= {item["container"]["name"] for item in body["items"]}
                if page >= body["page"]["pages"]:
                    break
                page += 1
            self.assertEqual(got, expected, status)
        live = make_user("ops2", all_customers=True)
        server = Server.objects.get(name="live")
        detail = self.get(live, f"servers/{server.pk}/").json()
        expected_counts = {key: 0 for key in ("critical", "warning", "unknown", "idle", "healthy")}
        for name, (state, health, observable) in grid.items():
            if name.startswith("live:"):
                expected_counts[reference_container(state, health, observable)] += 1
        self.assertEqual(detail["item"]["containers"]["counts"], expected_counts)
        self.assertEqual(detail["item"]["containers"]["total"], sum(expected_counts.values()))
        self.assertEqual(len(detail["containers"]), sum(expected_counts.values()))

    def test_absent_containers_are_not_served(self):
        server = make_server("host", now=self.now, cpu=None)
        make_docker_host(server, now=self.now)
        make_container(server, "here", now=self.now)
        make_container(server, "gone", now=self.now, present=False)
        user = make_user("ops", all_customers=True)
        body = self.get(user, "containers/").json()
        self.assertEqual([i["container"]["name"] for i in body["items"]], ["here"])
        self.assertEqual(body["scopeTotal"], 1)
        detail = self.get(user, f"servers/{server.pk}/").json()
        self.assertEqual([c["container"]["name"] for c in detail["containers"]], ["here"])
        self.assertEqual(detail["item"]["containers"]["total"], 1)

