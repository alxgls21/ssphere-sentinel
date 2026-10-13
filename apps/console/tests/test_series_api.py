"""``GET /servers/<id>/series/``: buckets, gaps, isolation, input checks and cost."""

from datetime import datetime, timedelta, timezone as dt_timezone
from unittest.mock import patch

from django.db import connection
from django.test import Client, override_settings
from django.test.utils import CaptureQueriesContext

from apps.console.history import RANGES, bucket_seconds
from apps.console.tests.helpers import (
    API,
    ConsoleDataTestCase,
    make_server,
    make_user,
    signed_in_client,
    start_console_session,
)
from apps.infrastructure.models import ServerTelemetrySample
from apps.inventory.models import Customer, Site

UTC = dt_timezone.utc


def add_samples(server, points):
    """``points``: ``(sampled_at, cpu, memory, disk)``."""
    ServerTelemetrySample.objects.bulk_create(
        ServerTelemetrySample(server=server, sampled_at=at, cpu_percent=c, memory_percent=m, disk_percent=d)
        for at, c, m, d in points
    )


@override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=60)
class SeriesTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.user = make_user("ops", all_customers=True)
        self.server = make_server("web", now=self.now, cpu=10)
        # Start of the last COMPLETE minute: the newest bucket the series serves (the current one is still filling).
        self.minute = int(self.now.timestamp()) // 60 * 60 - 60

    def at(self, minutes_ago):
        return datetime.fromtimestamp(self.minute - 60 * minutes_ago, tz=UTC)

    def series(self, **params):
        response = self.get(self.user, f"servers/{self.server.pk}/series/", **params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    # -- shape -------------------------------------------------------------------

    def test_every_range_has_the_ui_buckets_aligned_to_the_clock(self):
        expected = {"15m": (60, 15), "1h": (60, 60), "6h": (300, 72), "24h": (900, 96)}
        for key, (step, count) in expected.items():
            body = self.series(range=key)
            self.assertEqual(set(body), {"generatedAt", "bucketMs", "t", "cpu", "memory", "disk"})
            self.assertEqual(body["bucketMs"], step * 1000, key)
            self.assertEqual({len(body[name]) for name in ("t", "cpu", "memory", "disk")}, {count}, key)
            self.assertTrue(all(t % (step * 1000) == 0 for t in body["t"]), key)
            self.assertEqual([b - a for a, b in zip(body["t"], body["t"][1:])], [step * 1000] * (count - 1))
            # Only completed buckets: the newest ends where the current one starts.
            self.assertEqual(body["t"][-1], (int(self.now.timestamp()) // step * step - step) * 1000)

    def test_the_default_range_is_one_hour(self):
        self.assertEqual(self.series(), self.series(range="1h"))

    def test_the_range_is_covered_exactly(self):
        for key, (length, _step) in RANGES.items():
            body = self.series(range=key)
            self.assertEqual(body["t"][-1] - body["t"][0] + body["bucketMs"], int(length.total_seconds()) * 1000, key)

    # -- values ----------------------------------------------------------------------

    def test_buckets_hold_the_samples_and_gaps_are_null(self):
        add_samples(self.server, [(self.at(0), 10.0, 20.0, 30.0), (self.at(1), 12.5, 22.5, 32.5), (self.at(4), 50.0, 60.0, 70.0)])
        body = self.series(range="15m")
        self.assertEqual(body["cpu"][-1], 10.0)
        self.assertEqual(body["cpu"][-2], 12.5)
        self.assertEqual(body["memory"][-5], 60.0)
        self.assertEqual(body["disk"][-5], 70.0)
        self.assertEqual([i for i, v in enumerate(body["cpu"]) if v is None], [i for i in range(15) if i not in (10, 13, 14)])
        self.assertEqual(sum(v is not None for v in body["cpu"]), 3)

    def test_samples_in_a_bucket_are_averaged_to_two_decimals(self):
        # Five-minute buckets: every sample of the same five minutes lands in one.
        step = 300
        bucket = int(self.now.timestamp()) // step * step - step  # the last complete bucket
        add_samples(
            self.server,
            [(datetime.fromtimestamp(bucket + 60 * i, tz=UTC), v, 100 - v, 1.0) for i, v in enumerate((10.0, 20.0, 25.0, 10.0, 11.0))],
        )
        body = self.series(range="6h")
        index = body["t"].index(bucket * 1000)
        self.assertEqual((body["cpu"][index], body["memory"][index], body["disk"][index]), (15.2, 84.8, 1.0))

    def test_the_current_bucket_is_not_served_until_it_is_complete(self):
        """A trailing null must mean "stopped reporting" (the UI says so), not "this minute has not filled yet"."""
        for key, step in (("15m", 60), ("6h", 300), ("24h", 900)):
            start = int(self.now.timestamp()) // step * step
            ServerTelemetrySample.objects.all().delete()  # the slots of different grids coincide at some minutes
            add_samples(self.server, [(datetime.fromtimestamp(start, tz=UTC), 40.0, 1.0, 1.0)])
            body = self.series(range=key)
            self.assertNotIn(40.0, body["cpu"], key)
            self.assertEqual(body["t"][-1], (start - step) * 1000, key)
            self.assertLess(body["t"][-1] + body["bucketMs"], (self.now.timestamp() + 1) * 1000)

    def test_samples_outside_the_window_are_not_included(self):
        first = self.minute - 14 * 60  # the first bucket of the 15m range
        add_samples(
            self.server,
            [
                (datetime.fromtimestamp(first - 60, tz=UTC), 99.0, 99.0, 99.0),  # just before the window
                (datetime.fromtimestamp(first, tz=UTC), 1.0, 1.0, 1.0),  # its first instant
                (datetime.fromtimestamp(self.minute + 60, tz=UTC), 98.0, 98.0, 98.0),  # in the future
                (self.at(60 * 24 * 3), 97.0, 97.0, 97.0),  # days ago
            ],
        )
        body = self.series(range="15m")
        self.assertEqual([v for v in body["cpu"] if v is not None], [1.0])
        self.assertEqual(body["cpu"][0], 1.0)

    def test_a_silent_host_leaves_a_gap_not_zeros(self):
        add_samples(self.server, [(self.at(minutes), 5.0, 5.0, 5.0) for minutes in range(20, 30)])
        body = self.series(range="1h")
        self.assertEqual(sum(v is not None for v in body["cpu"]), 10)
        self.assertTrue(all(v is None for v in body["cpu"][-20:]))
        self.assertNotIn(0, [v for v in body["cpu"] if v is not None])

    def test_other_servers_samples_never_appear(self):
        other = make_server("other", now=self.now, cpu=10)
        add_samples(other, [(self.at(0), 77.0, 77.0, 77.0)])
        add_samples(self.server, [(self.at(1), 11.0, 11.0, 11.0)])
        self.assertEqual([v for v in self.series(range="15m")["cpu"] if v is not None], [11.0])

    def test_a_server_that_never_reported_has_empty_series(self):
        silent = make_server("silent", now=self.now, seen_ago=None, cpu=None)
        # A server that sends heartbeats but no telemetry has nothing either.
        no_telemetry = make_server("no-telemetry", now=self.now, seen_ago=5, cpu=None)
        for server in (silent, no_telemetry):
            body = self.get(self.user, f"servers/{server.pk}/series/", range="1h").json()
            self.assertEqual((body["t"], body["cpu"], body["memory"], body["disk"], body["bucketMs"]), ([], [], [], [], 60000))

    def test_the_bucket_is_never_finer_than_the_sample_grid(self):
        with override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=300):
            body = self.series(range="1h")
            self.assertEqual((body["bucketMs"], len(body["t"])), (300_000, 12))
            self.assertEqual(self.series(range="24h")["bucketMs"], 900_000)
            self.assertEqual(bucket_seconds("15m"), 300)

    # -- isolation -----------------------------------------------------------------------

    def estate(self):
        acme = Customer.objects.create(name="Acme")
        globex = Customer.objects.create(name="Globex")
        hq = Site.objects.create(customer=acme, name="HQ")
        plant = Site.objects.create(customer=globex, name="Plant")
        mine = make_server("acme-web", site=hq, now=self.now)
        theirs = make_server("globex-web", site=plant, now=self.now)
        loose = make_server("loose", now=self.now)
        add_samples(mine, [(self.at(0), 11.0, 11.0, 11.0)])
        add_samples(theirs, [(self.at(0), 66.5, 66.5, 66.5)])
        add_samples(loose, [(self.at(0), 44.5, 44.5, 44.5)])
        return acme, mine, theirs, loose

    def test_a_hidden_unassigned_or_unknown_server_is_the_same_404(self):
        acme, mine, theirs, loose = self.estate()
        user = make_user("acme", customers=[acme])
        from uuid import uuid4

        responses = [self.get(user, f"servers/{pk}/series/") for pk in (theirs.pk, loose.pk, uuid4())]
        for response in responses:
            self.assertEqual(response.status_code, 404)
            self.assertEqual(response.content, responses[0].content)
        ok = self.get(user, f"servers/{mine.pk}/series/")
        self.assertEqual(ok.status_code, 200)
        for leaked in ("66.5", "44.5"):
            self.assertNotIn(leaked, ok.content.decode())

    def test_all_customers_users_may_read_any_server_including_unassigned(self):
        _acme, _mine, theirs, loose = self.estate()
        for server in (theirs, loose):
            self.assertEqual(self.get(self.user, f"servers/{server.pk}/series/").status_code, 200)

    def test_site_grants_and_revocation(self):
        acme, mine, theirs, _loose = self.estate()
        user = make_user("plant", sites=[theirs.site])
        self.assertEqual(self.get(user, f"servers/{theirs.pk}/series/").status_code, 200)
        self.assertEqual(self.get(user, f"servers/{mine.pk}/series/").status_code, 404)

    def test_every_statement_on_the_history_carries_the_visibility_condition(self):
        acme, mine, _theirs, _loose = self.estate()
        client = signed_in_client(make_user("acme", customers=[acme]))
        client.get(f"{API}servers/{mine.pk}/series/")
        with CaptureQueriesContext(connection) as queries:
            client.get(f"{API}servers/{mine.pk}/series/?range=6h")
        history = [q["sql"] for q in queries if "servertelemetrysample" in q["sql"]]
        self.assertEqual(len(history), 1)
        self.assertIn('site_id" IN (', history[0])
        self.assertIn("sampled_at", history[0])

    # -- access and input ------------------------------------------------------------------

    def test_authentication(self):
        path = f"{API}servers/{self.server.pk}/series/"
        self.assertEqual(Client().get(path).status_code, 401)
        admin_session = Client()
        admin_session.force_login(make_user("root", console=False, superuser=True))
        self.assertEqual(admin_session.get(path).status_code, 401)
        no_console = make_user("granted", console=False, all_customers=True)
        self.assertEqual(self.get(no_console, f"servers/{self.server.pk}/series/").status_code, 403)
        client = signed_in_client(self.user)
        for method in ("post", "put", "patch", "delete"):
            self.assertEqual(getattr(client, method)(path).status_code, 405)
        self.assertEqual(client.head(path).status_code, 200)
        response = client.get(path)
        self.assertIn("no-store", response["Cache-Control"])

    def test_invalid_input_is_a_400_and_never_echoed(self):
        client = signed_in_client(self.user)
        base = f"{API}servers/{self.server.pk}/series/"
        for query, code in (
            ("range=2h", "invalid_parameter"),
            ("range=", "invalid_parameter"),
            ("range=1H", "invalid_parameter"),
            ("range=1h&range=6h", "invalid_parameter"),
            ("range=%00", "invalid_parameter"),
            ("range=" + "x" * 5000, "invalid_parameter"),
            ("from=1", "unknown_parameter"),
            ("page=1", "unknown_parameter"),
            ("range[]=1h", "unknown_parameter"),
        ):
            response = client.get(f"{base}?{query}")
            self.assertEqual(response.status_code, 400, query)
            self.assertEqual(response.json()["error"]["code"], code, query)
            self.assertNotIn("xxxxx", response.content.decode())
        for path in ("servers/1/series/", "servers/not-a-uuid/series/", f"servers/{self.server.pk}/series"):
            self.assertIn(client.get(API + path).status_code, (404, 301))

    # -- cost -------------------------------------------------------------------------------

    def test_a_request_is_one_history_query_whatever_the_history_holds(self):
        client = signed_in_client(self.user)
        path = f"{API}servers/{self.server.pk}/series/?range=24h"

        def history_queries():
            client.get(path)
            with CaptureQueriesContext(connection) as queries:
                self.assertEqual(client.get(path).status_code, 200)
            return len(queries), [q["sql"] for q in queries if "servertelemetrysample" in q["sql"]]

        small = history_queries()
        add_samples(self.server, [(self.at(minutes), 1.0, 1.0, 1.0) for minutes in range(0, 60 * 24 * 5)])  # 5 days of history
        large = history_queries()
        self.assertEqual((small[0], len(small[1])), (large[0], len(large[1])))
        self.assertEqual(len(large[1]), 1)
        # ...and only the window's rows are read: the statement is bounded by time on both sides.
        self.assertIn("sampled_at\" >=", large[1][0])
        self.assertIn("sampled_at\" <", large[1][0].replace("sampled_at\" <=", ""))

    def test_the_response_holds_a_bounded_number_of_points(self):
        add_samples(self.server, [(self.at(minutes), 1.0, 1.0, 1.0) for minutes in range(0, 60 * 24 * 5)])
        for key in RANGES:
            self.assertLessEqual(len(self.series(range=key)["t"]), 96)

    def test_sample_values_are_returned_as_numbers(self):
        add_samples(self.server, [(self.at(0), 12.34567, 1.0, 100.0)])
        body = self.series(range="15m")
        self.assertEqual((body["cpu"][-1], body["disk"][-1]), (12.35, 100.0))
        self.assertTrue(all(isinstance(t, int) for t in body["t"]))
        self.assertIsInstance(body["bucketMs"], int)

    def test_the_series_follows_a_patched_clock_consistently(self):
        later = self.now + timedelta(minutes=10)
        with patch("django.utils.timezone.now", return_value=later):
            body = self.series(range="15m")
        self.assertEqual(body["t"][-1], (int(later.timestamp()) // 60 * 60 - 60) * 1000)


class BuildSeriesTests(ConsoleDataTestCase):
    """The bucketing itself defends against rows outside the window, whatever the query returned."""

    def test_rows_outside_the_window_are_ignored_not_wrapped_around(self):
        from apps.console.history import build_series

        now = datetime.fromtimestamp(1_700_000_000, tz=UTC)
        current = 1_700_000_000 // 60 * 60  # the bucket that is still filling: not served
        first = current - 15 * 60
        rows = [
            (datetime.fromtimestamp(first - 1, tz=UTC), 90.0, 90.0, 90.0),  # one second before the window
            (datetime.fromtimestamp(first - 3600, tz=UTC), 91.0, 91.0, 91.0),
            (datetime.fromtimestamp(first, tz=UTC), 1.0, 2.0, 3.0),
            (datetime.fromtimestamp(current - 1, tz=UTC), 4.0, 5.0, 6.0),  # the last second of the last complete bucket
            (datetime.fromtimestamp(current, tz=UTC), 92.0, 92.0, 92.0),  # the current bucket
            (datetime.fromtimestamp(current + 60, tz=UTC), 93.0, 93.0, 93.0),  # after it
        ]
        body = build_series(rows, range_key="15m", now=now)
        self.assertEqual(body["t"][0], first * 1000)
        self.assertEqual(body["t"][-1], (current - 60) * 1000)
        self.assertEqual([v for v in body["cpu"] if v is not None], [1.0, 4.0])
        self.assertEqual((body["cpu"][0], body["cpu"][-1], body["memory"][-1], body["disk"][-1]), (1.0, 4.0, 5.0, 6.0))

    def test_no_rows(self):
        from apps.console.history import build_series

        body = build_series([], range_key="24h", now=datetime.fromtimestamp(1_700_000_000, tz=UTC))
        self.assertEqual((len(body["t"]), set(body["cpu"] + body["memory"] + body["disk"])), (96, {None}))


class SeriesPlanTests(ConsoleDataTestCase):
    """History for many servers: one server's chart reads that server's index range, nothing else."""

    @classmethod
    def setUpTestData(cls):
        from django.utils import timezone

        now = timezone.now()
        base = int(now.timestamp()) // 60 * 60
        servers = [make_server(f"s{i:03d}", now=now, cpu=10) for i in range(60)]
        ServerTelemetrySample.objects.bulk_create(
            (
                ServerTelemetrySample(
                    server=server, sampled_at=datetime.fromtimestamp(base - 60 * minute, tz=UTC), cpu_percent=1, memory_percent=2, disk_percent=3
                )
                for server in servers
                for minute in range(0, 60 * 24 * 2)
            ),
            batch_size=5000,
        )
        with connection.cursor() as cursor:
            cursor.execute("ANALYZE infrastructure_servertelemetrysample")
        cls.target = servers[7]

    def test_the_chart_query_uses_the_primary_key_index(self):
        client = signed_in_client(make_user("ops", all_customers=True))
        path = f"{API}servers/{self.target.pk}/series/?range=24h"
        client.get(path)
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(client.get(path).status_code, 200)
        sql = next(q["sql"] for q in queries if "servertelemetrysample" in q["sql"])
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL enable_seqscan = off")
            cursor.execute("EXPLAIN " + sql)
            plan = "\n".join(row[0] for row in cursor.fetchall())
            cursor.execute("RESET enable_seqscan")
        self.assertIn("infrastructure_servertelemetrysample_pkey", plan, plan)
        self.assertNotIn("Seq Scan on infrastructure_servertelemetrysample", plan, plan)
