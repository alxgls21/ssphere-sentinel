"""``GET /servers/series/`` and ``GET /targets/series/``: the sparklines of a page of each list."""

from datetime import datetime, timedelta, timezone as dt_timezone

from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext

from apps.console.tests.helpers import ConsoleDataTestCase, make_server, make_user
from apps.console.tests.test_series_api import add_samples
from apps.console.tests.test_targets_api import TargetTestCase
from apps.inventory.models import Customer, Site

UTC = dt_timezone.utc
SERVER_KEYS = {"generatedAt", "range", "bucketMs", "t", "items", "page"}


@override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=60)
class ServerFleetSeriesTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.admin = make_user("ops", all_customers=True)
        self.web = make_server("web", site=self.hq, now=self.now, cpu=10)
        self.db = make_server("db", site=self.hq, now=self.now, cpu=20)
        self.mill = make_server("mill", site=self.plant, now=self.now, cpu=30)

    def fleet(self, user=None, expect=200, **params):
        response = self.get(user or self.admin, "servers/series/", **params)
        self.assertEqual(response.status_code, expect, response.content[:300])
        return response.json()

    def listed(self, user=None, **params):
        response = self.get(user or self.admin, "servers/", **params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def window(self, step, count):
        """Start of each completed bucket, oldest first (the current one is still filling)."""
        last = int(self.now.timestamp()) // step * step - step
        return [datetime.fromtimestamp(last - step * (count - 1 - index), tz=UTC) for index in range(count)]

    def test_the_rows_are_the_list_s_page_in_its_order(self):
        for params in ({}, {"sort": "name"}, {"sort": "cpu", "dir": "desc"}, {"q": "web"}, {"pageSize": "2", "page": "2"},
                       {"site": str(self.hq.pk)}, {"status": "healthy"}):
            with self.subTest(params=params):
                fleet, listed = self.fleet(**params), self.listed(**params)
                self.assertEqual(set(fleet), SERVER_KEYS)
                self.assertEqual([item["serverId"] for item in fleet["items"]], [item["server"]["id"] for item in listed["items"]])
                self.assertEqual(fleet["page"], listed["page"])

    def test_every_range_has_at_most_24_buckets_on_the_sample_grid(self):
        expected = {"15m": (60, 15), "1h": (180, 20), "6h": (900, 24), "24h": (3600, 24)}
        for key, (step, count) in expected.items():
            with self.subTest(range=key):
                body = self.fleet(range=key)
                self.assertEqual((body["range"], body["bucketMs"], len(body["t"])), (key, step * 1000, count))
                self.assertTrue(all(t % (step * 1000) == 0 for t in body["t"]))
                for item in body["items"]:
                    self.assertEqual({len(item[name]) for name in ("cpu", "memory", "disk")}, {count})
        self.assertEqual(self.fleet()["range"], "1h")

    @override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=300)
    def test_a_coarser_grid_gives_fewer_buckets_never_an_empty_one_every_other_time(self):
        body = self.fleet(range="1h")
        self.assertEqual((body["bucketMs"], len(body["t"])), (300_000, 12))

    def test_a_bucket_is_the_mean_of_its_samples_and_empty_buckets_are_null(self):
        starts = self.window(180, 20)
        add_samples(self.web, [
            (starts[-1], 10, 20, 30), (starts[-1] + timedelta(seconds=60), 20, 40, 50),  # the newest bucket
            (starts[0] + timedelta(seconds=120), 33.333, 50, 70),                         # the oldest
            (starts[-1] + timedelta(seconds=180), 99, 99, 99),                            # the bucket still filling
            (starts[0] - timedelta(seconds=1), 99, 99, 99),                               # before the range
        ])
        (item,) = [item for item in self.fleet(range="1h")["items"] if item["serverId"] == str(self.web.pk)]
        self.assertEqual(item["cpu"][-1], 15.0)
        self.assertEqual(item["memory"][-1], 30.0)
        self.assertEqual(item["disk"][-1], 40.0)
        self.assertEqual(item["cpu"][0], 33.33)
        self.assertEqual(item["cpu"][1:-1], [None] * 18)

    def test_a_server_that_never_reported_has_a_row_of_nulls_the_same_length(self):
        body = self.fleet(range="1h")
        for item in body["items"]:
            self.assertEqual(item["cpu"], [None] * 20)

    def test_a_user_sees_the_servers_of_the_list_and_nothing_else(self):
        add_samples(self.mill, [(self.window(180, 20)[-1], 50, 50, 50)])
        acme_only = make_user("acme-only", customers=[self.acme])
        body = self.fleet(acme_only)
        self.assertEqual({item["serverId"] for item in body["items"]}, {str(self.web.pk), str(self.db.pk)})
        self.assertEqual(self.fleet(acme_only, expect=404, customer=str(self.globex.pk))["error"]["code"], "not_found")

    def test_at_most_50_rows_a_request_and_the_list_s_input_rules(self):
        self.assertEqual(self.fleet()["page"]["size"], 50)
        self.assertEqual(self.fleet(pageSize="50")["page"]["size"], 50)
        for params, code in (({"pageSize": "51"}, "invalid_parameter"), ({"range": "7d"}, "invalid_parameter"),
                             ({"sort": "uptime-ish"}, "invalid_parameter"), ({"page": "0"}, "invalid_parameter"),
                             ({"limit": "5"}, "unknown_parameter")):
            with self.subTest(params=params):
                self.assertEqual(self.fleet(expect=400, **params)["error"]["code"], code)

    def test_the_cost_does_not_grow_with_the_number_of_servers(self):
        def queries():
            with CaptureQueriesContext(connection) as captured:
                self.fleet(range="24h")
            return len(captured)

        few = queries()
        for index in range(12):
            server = make_server(f"extra-{index:02}", site=self.hq, now=self.now)
            add_samples(server, [(self.window(3600, 24)[-1], 5, 5, 5)])
        self.assertEqual(queries(), few)

    def test_only_signed_in_console_users(self):
        from django.test import Client

        self.assertEqual(Client().get("/api/v1/console/servers/series/").status_code, 401)


class TargetFleetSeriesTests(TargetTestCase):
    def fleet(self, user=None, expect=200, **params):
        response = self.get(user or self.admin, "targets/series/", **params)
        self.assertEqual(response.status_code, expect, response.content[:300])
        return response.json()

    def last_bucket_ago(self, step, offset=0):
        """Seconds ago of a moment ``offset`` seconds into the newest completed bucket."""
        start = int(self.now.timestamp()) // step * step - step
        return int(self.now.timestamp()) - (start + offset)

    def test_the_rows_are_the_list_s_page_in_its_order(self):
        for name in ("alpha", "beta", "gamma"):
            self.target(name)
        for params in ({}, {"sort": "name", "dir": "desc"}, {"pageSize": "2", "page": "2"}, {"q": "beta"}):
            with self.subTest(params=params):
                fleet, listed = self.fleet(**params), self.listed(**params)
                self.assertEqual(set(fleet), SERVER_KEYS)
                self.assertEqual([item["targetId"] for item in fleet["items"]], [item["target"]["id"] for item in listed["items"]])
                self.assertEqual(fleet["page"], listed["page"])

    def test_latency_of_the_answers_and_loss_with_a_failed_measurement_counting_as_total(self):
        target = self.target("edge")
        ago = self.last_bucket_ago(180)
        self.measure(target, ago - 10, latency=10.0, loss=0.0)
        self.measure(target, ago - 70, latency=20.0, loss=50.0)
        self.measure(target, ago - 130, success=False)
        (item,) = self.fleet(range="1h")["items"]
        self.assertEqual(item["latencyMs"][-1], 15.0)
        self.assertEqual(item["lossPercent"][-1], 50.0)  # (0 + 50 + 100) / 3
        self.assertEqual(item["latencyMs"][:-1], [None] * 19)
        self.assertEqual(item["lossPercent"][:-1], [None] * 19)

    def test_an_outage_is_full_loss_and_no_latency(self):
        target = self.target("down")
        self.measure(target, self.last_bucket_ago(180) - 10, success=False)
        (item,) = self.fleet(range="1h")["items"]
        self.assertIsNone(item["latencyMs"][-1])
        self.assertEqual(item["lossPercent"][-1], 100.0)

    def test_a_user_sees_the_targets_of_the_list_and_nothing_else(self):
        self.target("hq-gw", site="hq")
        self.target("plant-gw", site="plant")
        acme_only = make_user("acme-only", customers=[self.acme])
        names = {item["targetId"] for item in self.fleet(acme_only)["items"]}
        self.assertEqual(len(names), 1)
        self.assertEqual(self.fleet(acme_only, expect=404, customer=str(self.globex.pk))["error"]["code"], "not_found")

    def test_at_most_50_rows_a_request(self):
        self.assertEqual(self.fleet()["page"]["size"], 50)
        self.assertEqual(self.fleet(expect=400, pageSize="51")["error"]["code"], "invalid_parameter")
