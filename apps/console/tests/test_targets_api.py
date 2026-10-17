"""Network targets: ``/targets/``, ``/targets/<id>/`` and ``/targets/<id>/series/`` (``apps.console.targets``).

Health and its order of rules, missing and stale measurements, access and scope,
query validation and pagination, the recent measurements and the observed
availability, the series buckets, and the cost of a list.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone as dt_timezone

from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext

from apps.agents.services import create_agent
from apps.console.tests.helpers import API, ConsoleDataTestCase, make_server, make_user, signed_in_client
from apps.inventory.models import Customer, Site
from apps.network.models import NetworkMeasurement, NetworkTarget

THRESHOLDS = override_settings(
    SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT=2,
    SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS=150,
    SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES=3,
)


@THRESHOLDS
class TargetTestCase(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.server = make_server("probe-host", site=self.hq, now=self.now)
        self.agent, self.token = create_agent(server=self.server, name="probe-agent")
        self.seen(self.agent, 5)
        self.admin = make_user("ops", all_customers=True)

    def seen(self, agent, ago):
        agent.last_seen_at = None if ago is None else self.now - timedelta(seconds=ago)
        agent.save(update_fields=["last_seen_at"])

    def target(self, name="edge-gw", *, site="hq", agent="default", **fields):
        values = {
            "hostname_or_ip": "192.0.2.10",
            "protocol": NetworkTarget.Protocol.ICMP,
            "monitoring_interval_seconds": 60,
            **fields,
        }
        return NetworkTarget.objects.create(
            name=name,
            site={"hq": self.hq, "plant": self.plant, None: None}[site],
            assigned_agent=self.agent if agent == "default" else agent,
            **values,
        )

    def measure(self, target, ago, success=True, latency=12.5, loss=0.0, *, probes=4, reason=""):
        successful = probes - round(probes * loss / 100)
        if success:
            reason = ""
        else:
            latency, loss, successful, reason = None, 100.0, 0, reason or "timeout"
        return NetworkMeasurement.objects.create(
            id=uuid.uuid4(),
            target=target,
            agent=self.agent,
            measured_at=self.now - timedelta(seconds=ago),
            received_at=self.now - timedelta(seconds=max(ago - 1, 0)),
            success=success,
            latency_ms=latency,
            packet_loss_percentage=loss,
            probe_count=probes,
            successful_probes=successful,
            failure_reason=reason,
        )

    def detail(self, target, user=None):
        response = self.get(user or self.admin, f"targets/{target.pk}/")
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def listed(self, user=None, **params):
        response = self.get(user or self.admin, "targets/", **params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()


class TargetHealthTests(TargetTestCase):
    def status(self, target):
        item = self.detail(target)["item"]
        return item["health"], item["reason"], item["stale"]

    def test_the_rules_in_their_order(self):
        def failures(target, count, *, after_success=True):
            if after_success:
                self.measure(target, 60 * (count + 1))
            for i in range(count):
                self.measure(target, 10 + 30 * (count - 1 - i), success=False)

        cases = []
        # Disabled before everything: even failing.
        t = self.target("disabled", enabled=False)
        failures(t, 3)
        cases.append((t, ("idle", "disabled", False)))
        t = self.target("no-agent", agent=None)
        self.measure(t, 10)
        cases.append((t, ("unknown", "no_agent", False)))
        # The agent's state before the measurements: a failing target of a silent agent is unknown.
        silent = create_agent(server=make_server("silent-host", site=self.hq, now=self.now), name="silent")[0]
        self.seen(silent, 200)
        t = self.target("agent-silent", agent=silent)
        failures(t, 3)
        cases.append((t, ("unknown", "agent_offline", False)))
        never = create_agent(server=make_server("never-host", site=self.hq, now=self.now), name="never")[0]
        self.seen(never, None)
        t = self.target("agent-never-seen", agent=never)
        self.measure(t, 10)
        cases.append((t, ("unknown", "agent_offline", False)))
        disabled_agent = create_agent(server=make_server("off-host", site=self.hq, now=self.now), name="off")[0]
        self.seen(disabled_agent, 5)
        disabled_agent.enabled = False
        disabled_agent.save(update_fields=["enabled"])
        t = self.target("agent-disabled", agent=disabled_agent)
        self.measure(t, 10)
        cases.append((t, ("unknown", "agent_offline", False)))
        t = self.target("never-measured")
        cases.append((t, ("unknown", "no_measurement", False)))
        # Stale before failures: three failures that are all older than the window are unknown, not critical.
        t = self.target("stale-failing")
        for ago in (500, 400, 300):
            self.measure(t, ago, success=False)
        cases.append((t, ("unknown", "stale", True)))
        t = self.target("failing")
        failures(t, 3)
        cases.append((t, ("critical", "failing", False)))
        t = self.target("failing-long")
        failures(t, 7)
        cases.append((t, ("critical", "failing", False)))
        t = self.target("two-failures")
        failures(t, 2)
        cases.append((t, ("warning", "failed", False)))
        t = self.target("one-failure")
        failures(t, 1)
        cases.append((t, ("warning", "failed", False)))
        # Fewer measurements than the threshold, all failed: not yet critical.
        t = self.target("new-and-failing")
        failures(t, 2, after_success=False)
        cases.append((t, ("warning", "failed", False)))
        t = self.target("recovered")
        failures(t, 4)
        self.measure(t, 5)
        cases.append((t, ("healthy", "ok", False)))
        t = self.target("slow")
        self.measure(t, 10, latency=150.0)
        cases.append((t, ("warning", "latency", False)))
        t = self.target("almost-slow")
        self.measure(t, 10, latency=149.9)
        cases.append((t, ("healthy", "ok", False)))
        t = self.target("lossy")
        self.measure(t, 10, loss=25.0)
        cases.append((t, ("warning", "loss", False)))
        t = self.target("ok")
        self.measure(t, 10)
        cases.append((t, ("healthy", "ok", False)))
        for target, expected in cases:
            with self.subTest(target.name):
                self.assertEqual(self.status(target), expected)

    def test_a_measurement_is_current_for_three_intervals_and_at_least_the_offline_threshold(self):
        # interval 60: 180 s; interval 10: the offline threshold (90 s); interval 600: 1800 s.
        for interval, ago, stale in ((60, 179, False), (60, 181, True), (10, 89, False), (10, 91, True), (600, 1700, False), (600, 1900, True)):
            with self.subTest(interval=interval, ago=ago):
                target = self.target(f"t-{interval}-{ago}", monitoring_interval_seconds=interval)
                self.measure(target, ago)
                health, reason, flagged = self.status(target)
                self.assertEqual((health, reason, flagged), ("unknown", "stale", True) if stale else ("healthy", "ok", False))

    def test_a_late_delivery_is_judged_by_when_it_was_measured(self):
        target = self.target()
        measurement = self.measure(target, 3600)
        measurement.received_at = self.now
        measurement.save(update_fields=["received_at"])
        self.assertEqual(self.status(target), ("unknown", "stale", True))

    @override_settings(SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES=1)
    def test_with_a_threshold_of_one_the_first_failure_is_critical(self):
        target = self.target()
        self.measure(target, 60)
        self.measure(target, 10, success=False)
        self.assertEqual(self.status(target), ("critical", "failing", False))

    def test_the_stale_reading_is_still_served_as_the_last_known(self):
        target = self.target()
        self.measure(target, 1000, latency=33.0)
        item = self.detail(target)["item"]
        self.assertEqual(item["latest"]["latencyMs"], 33.0)
        self.assertTrue(item["stale"])

    def test_the_list_counts_and_the_detail_agree(self):
        for name, ago, success in (("a", 10, True), ("b", 10, False), ("c", 1000, True)):
            self.measure(self.target(name), ago, success=success)
        self.target("d", enabled=False)
        body = self.listed()
        self.assertEqual(body["counts"], {"critical": 0, "warning": 1, "unknown": 1, "idle": 1, "healthy": 1})
        for item in body["items"]:
            self.assertEqual(item, self.detail(NetworkTarget.objects.get(pk=item["target"]["id"]))["item"])


class TargetItemTests(TargetTestCase):
    def test_identity_configuration_agent_and_latest_measurement(self):
        target = self.target(
            "edge-tcp", protocol=NetworkTarget.Protocol.TCP, port=443, hostname_or_ip="edge.example.net",
            timeout_seconds=3, circuit_identifier="CIRC-42",
        )
        self.measure(target, 10, latency=21.25, loss=25.0, probes=4)
        item = self.detail(target)["item"]
        self.assertEqual(
            item["target"],
            {
                "id": str(target.pk), "name": "edge-tcp", "address": "edge.example.net", "protocol": "tcp", "port": 443,
                "enabled": True, "intervalSeconds": 60, "timeoutSeconds": 3, "circuitId": "CIRC-42",
                "siteId": str(self.hq.pk), "agentAssigned": True,
                "agent": {
                    "id": str(self.agent.pk), "name": "probe-agent", "status": "online",
                    "lastSeenAt": self.iso(self.now - timedelta(seconds=5)),
                    "serverId": str(self.server.pk), "serverName": "probe-host",
                },
            },
        )
        self.assertEqual(
            item["latest"],
            {
                "measuredAt": self.iso(self.now - timedelta(seconds=10)), "receivedAt": self.iso(self.now - timedelta(seconds=9)),
                "success": True, "latencyMs": 21.25, "lossPercent": 25.0, "probeCount": 4, "successfulProbes": 3,
                "failureReason": None,
            },
        )
        self.assertEqual((item["customerName"], item["siteName"], item["health"], item["reason"]), ("Acme", "HQ", "warning", "loss"))
        self.assertEqual(set(item), {"target", "latest", "stale", "health", "reason", "customerName", "siteName"})

    def test_a_failed_measurement_has_no_latency_and_says_why(self):
        target = self.target()
        self.measure(target, 10, success=False, reason="host_unreachable")
        latest = self.detail(target)["item"]["latest"]
        self.assertEqual((latest["success"], latest["latencyMs"], latest["lossPercent"], latest["failureReason"]),
                         (False, None, 100.0, "host_unreachable"))

    def test_without_a_measurement_or_an_agent_there_is_nothing_made_up(self):
        target = self.target(agent=None)
        item = self.detail(target)["item"]
        self.assertEqual((item["latest"], item["stale"], item["target"]["agentAssigned"], item["target"]["agent"]), (None, False, False, None))

    def iso(self, value: datetime) -> str:
        return value.astimezone(dt_timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class TargetAccessTests(TargetTestCase):
    def setUp(self):
        super().setUp()
        self.t_hq = self.target("t-hq")
        self.t_plant = self.target("t-plant", site="plant")
        self.t_none = self.target("t-none", site=None)
        for t in (self.t_hq, self.t_plant, self.t_none):
            self.measure(t, 10)

    def names(self, response):
        self.assertEqual(response.status_code, 200, response.content[:300])
        return sorted(item["target"]["name"] for item in response.json()["items"])

    def test_signed_out_and_without_console_access(self):
        client = signed_in_client(make_user("plain", console=False))
        for path in ("targets/", f"targets/{self.t_hq.pk}/", f"targets/{self.t_hq.pk}/series/"):
            with self.subTest(path):
                self.assertEqual(self.client.get(API + path).status_code, 401)
                self.assertEqual(client.get(API + path).status_code, 403)

    def test_each_user_sees_the_targets_of_their_sites_only(self):
        acme = make_user("acme", customers=[self.acme])
        plant = make_user("plant", sites=[self.plant])
        self.assertEqual(self.names(self.get(self.admin, "targets/")), ["t-hq", "t-none", "t-plant"])
        self.assertEqual(self.names(self.get(acme, "targets/")), ["t-hq"])
        self.assertEqual(self.names(self.get(plant, "targets/")), ["t-plant"])
        self.assertEqual(self.get(acme, "targets/").json()["scopeTotal"], 1)
        self.assertEqual(self.names(self.get(self.admin, "targets/", customer=str(self.globex.pk))), ["t-plant"])
        self.assertEqual(self.get(acme, "targets/", customer=str(self.globex.pk)).status_code, 404)

    def test_a_hidden_target_is_not_found_like_one_that_does_not_exist(self):
        acme = make_user("acme", customers=[self.acme])
        for target in (self.t_plant, self.t_none):
            for path in (f"targets/{target.pk}/", f"targets/{target.pk}/series/"):
                with self.subTest(path):
                    response = self.get(acme, path)
                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "not_found"))
        self.assertEqual(self.get(acme, f"targets/{uuid.uuid4()}/").status_code, 404)
        self.assertEqual(self.get(acme, "targets/not-a-uuid/").status_code, 404)

    def test_the_agent_is_shown_only_when_its_server_is_visible(self):
        # The agent runs on a server at HQ and probes a target at the plant: a plant user sees the target, not the agent.
        plant = make_user("plant", sites=[self.plant])
        item = self.detail(self.t_plant, plant)["item"]
        self.assertEqual((item["target"]["agentAssigned"], item["target"]["agent"]), (True, None))
        self.assertEqual(self.detail(self.t_plant)["item"]["target"]["agent"]["name"], "probe-agent")

    def test_no_secret_is_read_or_sent(self):
        client = signed_in_client(self.admin)
        client.get(API + "targets/")
        with CaptureQueriesContext(connection) as queries:
            bodies = [client.get(API + path).content.decode() for path in
                      ("targets/", f"targets/{self.t_hq.pk}/", f"targets/{self.t_hq.pk}/series/")]
        for query in queries:
            self.assertNotIn("token_hash", query["sql"])
        for body in bodies:
            for secret in (self.token, self.agent.token_hash, "hash", "token"):
                self.assertNotIn(secret, body)

    def test_every_measurement_query_goes_through_the_visibility_filter(self):
        acme = make_user("acme", customers=[self.acme])
        client = signed_in_client(acme)
        client.get(API + "targets/")
        for path in ("targets/", f"targets/{self.t_hq.pk}/", f"targets/{self.t_hq.pk}/series/"):
            with self.subTest(path), CaptureQueriesContext(connection) as queries:
                self.assertEqual(client.get(API + path).status_code, 200)
            touching = [query["sql"] for query in queries if "network_" in query["sql"]]
            self.assertTrue(touching)
            for sql in touching:
                self.assertIn('"site_id" IN', sql, sql[:400])


class TargetListTests(TargetTestCase):
    def setUp(self):
        super().setUp()
        # name, ago, success, latency, loss
        rows = (
            ("Alpha", 10, True, 40.0, 0.0),
            ("bravo", 10, True, 10.0, 0.0),
            ("charlie", 10, True, 300.0, 0.0),  # slow: warning
            ("delta", 1000, True, 1.0, 0.0),  # stale: its latency is not current
            ("echo", 10, False, None, 100.0),  # failed: warning, no latency
            ("foxtrot", None, None, None, None),  # never measured
        )
        for name, ago, success, latency, loss in rows:
            target = self.target(name, circuit_identifier=f"circ-{name.lower()}")
            if ago is not None:
                self.measure(target, ago, success=success, latency=latency, loss=loss)

    def names(self, **params):
        return [item["target"]["name"] for item in self.listed(**params)["items"]]

    def test_status_first_by_default_and_every_sort(self):
        self.assertEqual(self.names(), ["charlie", "echo", "delta", "foxtrot", "Alpha", "bravo"])
        self.assertEqual(self.names(sort="name"), ["Alpha", "bravo", "charlie", "delta", "echo", "foxtrot"])
        self.assertEqual(self.names(sort="name", dir="desc"), ["foxtrot", "echo", "delta", "charlie", "bravo", "Alpha"])
        # Latency: current successful readings only, the rest last both ways.
        self.assertEqual(self.names(sort="latency"), ["charlie", "Alpha", "bravo", "delta", "echo", "foxtrot"])
        self.assertEqual(self.names(sort="latency", dir="asc"), ["bravo", "Alpha", "charlie", "delta", "echo", "foxtrot"])
        # Loss: a failed current measurement counts (100 %), a stale one does not.
        self.assertEqual(self.names(sort="loss")[:1], ["echo"])
        self.assertEqual(self.names(sort="loss")[-2:], ["delta", "foxtrot"])
        # Measured: the oldest first, never measured last.
        self.assertEqual(self.names(sort="measured")[0], "delta")
        self.assertEqual(self.names(sort="measured")[-1], "foxtrot")

    def test_status_filter_counts_and_scope_total(self):
        body = self.listed(status="warning")
        self.assertEqual(sorted(i["target"]["name"] for i in body["items"]), ["charlie", "echo"])
        self.assertEqual(body["counts"], {"critical": 0, "warning": 2, "unknown": 2, "idle": 0, "healthy": 2})
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (2, 6))
        body = self.listed(q="circ-al")
        self.assertEqual(([i["target"]["name"] for i in body["items"]], body["scopeTotal"]), (["Alpha"], 6))
        self.assertEqual(self.names(q="192.0.2.10 hq"), self.names())  # address and site name

    def test_pagination(self):
        body = self.listed(sort="name", pageSize=4, page=2)
        self.assertEqual([i["target"]["name"] for i in body["items"]], ["echo", "foxtrot"])
        self.assertEqual(body["page"], {"number": 2, "size": 4, "total": 6, "pages": 2})
        self.assertEqual(self.listed(page=3, pageSize=4)["items"], [])

    def test_invalid_queries(self):
        for params in ({"sort": "jitter"}, {"status": "ok"}, {"dir": "up"}, {"pageSize": "0"}, {"pageSize": "201"},
                       {"page": "-1"}, {"site": "not-a-uuid"}, {"agent": "x"}):
            with self.subTest(params):
                response = self.get(self.admin, "targets/", **params)
                self.assertEqual(response.status_code, 400, response.content[:200])
        target = NetworkTarget.objects.get(name="Alpha")
        self.assertEqual(self.get(self.admin, f"targets/{target.pk}/", page="1").status_code, 400)
        self.assertEqual(self.get(self.admin, f"targets/{target.pk}/series/", range="7d").status_code, 400)
        self.assertEqual(signed_in_client(self.admin).post(API + "targets/").status_code, 405)


class TargetDetailTests(TargetTestCase):
    def test_the_recent_measurements_newest_first_with_their_failure_reasons(self):
        target = self.target()
        for i in range(25):
            self.measure(target, 10 + 60 * i, success=i % 5 != 0, reason="dns_failure")
        measurements = self.detail(target)["measurements"]
        self.assertEqual(len(measurements), 20)
        times = [m["measuredAt"] for m in measurements]
        self.assertEqual(times, sorted(times, reverse=True))
        self.assertEqual(measurements[0]["failureReason"], "dns_failure")  # i = 0 failed
        self.assertIsNone(measurements[1]["failureReason"])

    def test_the_observed_availability_of_the_last_24_hours(self):
        target = self.target(monitoring_interval_seconds=60)
        for i in range(10):
            self.measure(target, 30 + 600 * i, success=i >= 3)
        self.measure(target, 25 * 3600)  # outside the window
        observed = self.detail(target)["availability24h"]
        self.assertEqual(
            {k: observed[k] for k in ("measurements", "successful", "percent", "expectedMeasurements", "coveragePercent")},
            {"measurements": 10, "successful": 7, "percent": 70.0, "expectedMeasurements": 1440, "coveragePercent": 0.7},
        )
        self.assertEqual(observed["to"][:19], self.now.astimezone(dt_timezone.utc).isoformat()[:19])

    def test_without_measurements_there_is_no_availability_figure(self):
        observed = self.detail(self.target())["availability24h"]
        self.assertEqual((observed["measurements"], observed["percent"], observed["coveragePercent"]), (0, None, 0.0))


class TargetSeriesTests(TargetTestCase):
    def series(self, target, range_key="1h"):
        response = self.get(self.admin, f"targets/{target.pk}/series/", range=range_key)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def at(self, body, index_from_end, key):
        return body[key][len(body[key]) - index_from_end]

    def test_buckets_hold_what_was_measured_and_null_where_nothing_was(self):
        target = self.target()
        step = 60
        current = int(self.now.timestamp()) // step * step  # start of the bucket in progress
        def put(bucket_from_end, offset, **kwargs):
            measured = datetime.fromtimestamp(current - bucket_from_end * step + offset, tz=dt_timezone.utc)
            self.measure(target, (self.now - measured).total_seconds(), **kwargs)
        put(1, 5, latency=10.0, loss=0.0)
        put(1, 35, latency=30.0, loss=50.0)
        put(2, 10, success=False)
        put(4, 20, latency=7.0)
        put(0, 1, latency=999.0)  # in the bucket in progress: not served
        body = self.series(target)
        self.assertEqual(body["bucketMs"], 60_000)
        self.assertEqual(len(body["t"]), 60)
        self.assertEqual(body["t"][-1], (current - step) * 1000)
        self.assertEqual((self.at(body, 1, "latencyMs"), self.at(body, 1, "latencyMaxMs"), self.at(body, 1, "lossPercent")), (20.0, 30.0, 25.0))
        self.assertEqual((self.at(body, 1, "measurements"), self.at(body, 1, "failed")), (2, 0))
        # Only a failure: counted, no latency or loss invented.
        self.assertEqual([self.at(body, 2, k) for k in ("latencyMs", "lossPercent", "measurements", "failed")], [None, None, 1, 1])
        self.assertEqual([self.at(body, 3, k) for k in ("latencyMs", "measurements")], [None, 0])
        self.assertEqual(self.at(body, 4, "latencyMs"), 7.0)
        self.assertNotIn(999.0, body["latencyMs"])

    def test_the_bucket_is_never_shorter_than_the_interval(self):
        target = self.target(monitoring_interval_seconds=300)
        self.measure(target, 400)
        body = self.series(target, "1h")
        self.assertEqual((body["bucketMs"], len(body["t"])), (300_000, 12))
        self.assertEqual(self.series(target, "24h")["bucketMs"], 900_000)

    def test_a_target_never_measured_has_empty_arrays(self):
        body = self.series(self.target())
        self.assertEqual({k: body[k] for k in ("t", "latencyMs", "latencyMaxMs", "lossPercent", "measurements", "failed")},
                         {k: [] for k in ("t", "latencyMs", "latencyMaxMs", "lossPercent", "measurements", "failed")})


class TargetPerformanceTests(TargetTestCase):
    """A list of 200 targets with long histories: a constant number of queries, and bounded lookups per target."""

    def grow(self, targets, history, *, start=0, failing=False):
        created = NetworkTarget.objects.bulk_create(
            NetworkTarget(name=f"t-{start + i:04d}", hostname_or_ip="192.0.2.1", protocol="icmp", site=self.hq,
                          assigned_agent=self.agent, monitoring_interval_seconds=60)
            for i in range(targets)
        )
        NetworkMeasurement.objects.bulk_create(
            NetworkMeasurement(
                id=uuid.uuid4(), target=target, agent=self.agent, measured_at=self.now - timedelta(seconds=10 + 60 * j),
                received_at=self.now, success=not failing and j % 7 != 0, latency_ms=None if failing or j % 7 == 0 else 5.0,
                packet_loss_percentage=100.0 if failing or j % 7 == 0 else 0.0, probe_count=4,
                successful_probes=0 if failing or j % 7 == 0 else 4, failure_reason="timeout" if failing or j % 7 == 0 else "",
            )
            for target in created
            for j in range(history)
        )
        return created

    def count(self, client, path):
        client.get(API + path)
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(client.get(API + path).status_code, 200)
        return len(queries)

    def test_the_number_of_queries_does_not_grow_with_the_targets(self):
        client = signed_in_client(make_user("acme", customers=[self.acme]))
        self.grow(3, 5)
        first = NetworkTarget.objects.order_by("name").first()
        paths = ["targets/", "targets/?sort=latency", "targets/?q=t-&status=healthy", f"targets/{first.pk}/",
                 f"targets/{first.pk}/series/?range=24h"]
        small = {path: self.count(client, path) for path in paths}
        self.grow(200, 5, start=3)
        large = {path: self.count(client, path) for path in paths}
        self.assertEqual(small, large)

    def listing_cost(self):
        """``(milliseconds, measurement rows read)`` of the statement that lists a page of 200 targets."""
        with connection.cursor() as cursor:
            cursor.execute("ANALYZE")
        client = signed_in_client(self.admin)
        client.get(API + "targets/?pageSize=200")
        with CaptureQueriesContext(connection) as queries:
            body = client.get(API + "targets/?pageSize=200").json()
        self.assertEqual(body["counts"]["critical"], 200)
        listing = max((q["sql"] for q in queries if "network_networktarget" in q["sql"] and "LIMIT 200" in q["sql"]), key=len)
        with connection.cursor() as cursor:
            cursor.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + listing)
            plan = cursor.fetchone()[0][0]
        rows = sum(node.get("Actual Rows", 0) * node.get("Actual Loops", 1)
                   for node in walk(plan["Plan"]) if node.get("Relation Name") == "network_networkmeasurement")
        return plan["Execution Time"], rows

    def test_consecutive_failures_read_the_same_rows_however_long_the_failing_history(self):
        # 200 targets failing for 30 rounds, then for 300: the "N in a row" check reads the latest
        # few rows of each, never its history.
        targets = self.grow(200, 30, failing=True)
        short_ms, short_rows = self.listing_cost()
        NetworkMeasurement.objects.bulk_create(
            NetworkMeasurement(
                id=uuid.uuid4(), target=target, agent=self.agent, measured_at=self.now - timedelta(seconds=10 + 60 * j),
                received_at=self.now, success=False, latency_ms=None, packet_loss_percentage=100.0, probe_count=4,
                successful_probes=0, failure_reason="timeout",
            )
            for target in targets
            for j in range(30, 300)
        )
        long_ms, long_rows = self.listing_cost()
        self.assertEqual(short_rows, long_rows)
        self.assertLessEqual(long_rows, 200 * 30)
        print(f"\n200 targets, 30 and 300 failed measurements each: list statement {short_ms:.1f} ms and "
              f"{long_ms:.1f} ms, {long_rows:.0f} measurement rows read ({long_rows / 200:.0f} per target)")


def walk(node):
    yield node
    for child in node.get("Plans", []):
        yield from walk(child)
