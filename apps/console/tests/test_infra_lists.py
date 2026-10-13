"""The server and container lists: pagination, sorting, searching, counts, invalid input."""

import itertools
from datetime import timedelta
from urllib.parse import quote

from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.console.params import MAX_PAGE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH, MAX_SEARCH_WORDS
from apps.console.tests.helpers import (
    API,
    ConsoleDataTestCase,
    make_container,
    make_docker_host,
    make_server,
    make_user,
    signed_in_client,
)
from apps.inventory.models import Customer, Site

from apps.console.tests.helpers import fixed

RANK = {"critical": 0, "warning": 1, "unknown": 2, "healthy": 4}


class Fleet:
    """Servers chosen so that every sort key has ties, gaps (offline, never reported) and mixed case."""

    # name, seen_ago, cpu, memory, disk, uptime
    ROWS = (
        ("Alpha", 10, 50.0, 10.0, 20.0, 100),
        ("bravo", 20, 50.0, 90.0, 20.0, 300),
        ("charlie", 30, 97.0, 5.0, 5.0, 200),
        ("Delta", 500, 99.0, 99.0, 99.0, 999),  # offline: its load is not current
        ("echo", None, None, 0.0, 0.0, 0),  # never reported
        ("alpha2", 5, 85.0, 40.0, 20.0, 100),
        ("Foxtrot", 600, 1.0, 1.0, 1.0, 5),  # offline, silent for ten minutes
    )

    def __init__(self, now):
        self.records = []
        for name, seen, cpu, memory, disk, uptime in self.ROWS:
            make_server(name, now=now, seen_ago=seen, cpu=cpu, memory=memory, disk=disk, uptime=uptime)
            offline = seen is not None and seen > 90
            if seen is None:
                health = "unknown"
            elif offline:
                health = "critical"
            elif max(cpu, memory, disk) >= 95:
                health = "critical"
            elif max(cpu, memory, disk) >= 80:
                health = "warning"
            else:
                health = "healthy"
            reporting = seen is not None and not offline
            self.records.append(
                {
                    "name": name,
                    "health": health,
                    "seen": seen,
                    "cpu": cpu if reporting else None,
                    "memory": memory if reporting else None,
                    "disk": disk if reporting else None,
                    "uptime": uptime if reporting else None,
                }
            )

    def expected(self, sort, direction):
        """Names in the order the API documents for ``sort`` and ``direction``."""
        reverse = direction == "desc"
        records = sorted(self.records, key=lambda r: r["name"].lower())  # tie-break, always ascending
        if sort == "name":
            return [r["name"] for r in sorted(records, key=lambda r: r["name"].lower(), reverse=reverse)]
        if sort == "status":
            # "desc" = worst first = lowest rank first.
            return [r["name"] for r in sorted(records, key=lambda r: RANK[r["health"]], reverse=not reverse)]
        if sort == "seen":
            # By time since the last heartbeat: desc = the longest silent first; never reported last either way.
            have = [r for r in records if r["seen"] is not None]
            none = [r for r in records if r["seen"] is None]
            have = sorted(have, key=lambda r: r["seen"], reverse=reverse)
            return [r["name"] for r in have + none]
        have = [r for r in records if r[sort] is not None]
        none = [r for r in records if r[sort] is None]
        have = sorted(have, key=lambda r: r[sort], reverse=reverse)
        return [r["name"] for r in have + none]


class ServerListTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.user = make_user("ops", all_customers=True)
        self.fleet = Fleet(self.now)

    def test_every_sort_key_and_direction_follows_the_documented_order(self):
        for sort, direction in itertools.product(("status", "name", "cpu", "memory", "disk", "uptime", "seen"), ("asc", "desc")):
            names = self.names(self.get(self.user, "servers/", sort=sort, dir=direction))
            self.assertEqual(names, self.fleet.expected(sort, direction), (sort, direction))

    def test_the_default_order_is_worst_first_then_by_name(self):
        names = self.names(self.get(self.user, "servers/"))
        self.assertEqual(names, self.fleet.expected("status", "desc"))
        self.assertEqual(names[:3], ["charlie", "Delta", "Foxtrot"])  # the critical ones, by name

    def test_each_sort_key_starts_in_its_natural_direction(self):
        for sort, direction in (("name", "asc"), ("cpu", "desc"), ("memory", "desc"), ("disk", "desc"), ("uptime", "desc"), ("seen", "desc"), ("status", "desc")):
            self.assertEqual(
                self.names(self.get(self.user, "servers/", sort=sort)),
                self.fleet.expected(sort, direction),
                sort,
            )

    def test_servers_that_are_not_reporting_sort_last_in_both_directions(self):
        for direction in ("asc", "desc"):
            names = self.names(self.get(self.user, "servers/", sort="cpu", dir=direction))
            self.assertEqual(set(names[-3:]), {"Delta", "echo", "Foxtrot"})

    def test_names_sort_case_insensitively(self):
        names = self.names(self.get(self.user, "servers/", sort="name"))
        self.assertEqual(names, ["Alpha", "alpha2", "bravo", "charlie", "Delta", "echo", "Foxtrot"])

    def test_names_sort_by_byte_value_whatever_the_database_collation(self):
        """Under a language collation punctuation is ignored (``ab`` < ``a-c`` < ``a_d``); byte order is not."""
        for name in ("ab", "a-c", "a_d", "A-B"):
            make_server(name, now=self.now)
        names = self.names(self.get(self.user, "servers/", sort="name", q="a", pageSize=200))
        self.assertEqual([n for n in names if n.lower() in ("a-b", "a-c", "a_d", "ab")], ["A-B", "a-c", "a_d", "ab"])
        # Digits are compared as text, not as numbers (documented).
        make_server("web-10", now=self.now)
        make_server("web-2", now=self.now)
        self.assertEqual(self.names(self.get(self.user, "servers/", sort="name", q="web-", pageSize=200)), ["web-10", "web-2"])

    def test_seen_orders_by_the_time_since_the_last_heartbeat(self):
        """The UI's direction: desc = the longest silent first, asc = the most recent first."""
        silent = self.names(self.get(self.user, "servers/", sort="seen", dir="desc"))
        self.assertEqual(silent, ["Foxtrot", "Delta", "charlie", "bravo", "Alpha", "alpha2", "echo"])
        recent = self.names(self.get(self.user, "servers/", sort="seen", dir="asc"))
        self.assertEqual(recent, ["alpha2", "Alpha", "bravo", "charlie", "Delta", "Foxtrot", "echo"])

    def test_the_status_filter_narrows_the_list_but_not_the_counts(self):
        body = self.get(self.user, "servers/", status="critical").json()
        self.assertEqual(sorted(i["server"]["name"] for i in body["items"]), ["Delta", "Foxtrot", "charlie"])
        self.assertEqual(body["page"]["total"], 3)
        self.assertEqual(body["counts"], {"critical": 3, "warning": 2, "unknown": 1, "idle": 0, "healthy": 1})
        self.assertEqual(body["scopeTotal"], 7)

    def test_counts_follow_the_search_and_scope_total_does_not(self):
        body = self.get(self.user, "servers/", q="alpha").json()
        self.assertEqual(sorted(i["server"]["name"] for i in body["items"]), ["Alpha", "alpha2"])
        self.assertEqual(body["counts"], {"critical": 0, "warning": 1, "unknown": 0, "idle": 0, "healthy": 1})
        self.assertEqual(body["scopeTotal"], 7)
        self.assertEqual(body["page"]["total"], 2)

    def test_a_filter_with_no_match_is_an_empty_page_not_an_error(self):
        body = self.get(self.user, "servers/", q="no-such-server").json()
        self.assertEqual(body["items"], [])
        self.assertEqual(body["page"], {"number": 1, "size": 50, "total": 0, "pages": 1})
        self.assertEqual(sum(body["counts"].values()), 0)

    def test_telemetry_of_servers_that_are_not_reporting_is_still_the_last_sample_with_its_time(self):
        body = self.get(self.user, "servers/", q="Delta").json()
        telemetry = body["items"][0]["server"]["telemetry"]
        self.assertEqual(telemetry["cpuPercent"], 99.0)
        self.assertTrue(telemetry["collectedAt"].endswith("Z"))
        never = self.get(self.user, "servers/", q="echo").json()["items"][0]["server"]
        self.assertEqual((never["telemetry"], never["lastSeenAt"], never["status"]), (None, None, "unknown"))


class PaginationTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.user = make_user("ops", all_customers=True)
        for i in range(23):
            # Few distinct values, so every sort key has long runs of ties.
            make_server(
                f"p-{i:02d}",
                now=self.now,
                seen_ago=None if i % 7 == 0 else (5 if i % 5 else 600),
                cpu=None if i % 7 == 0 else float(10 * (i % 4)),
                memory=float(i % 3),
                disk=float(i % 2),
                uptime=i % 3,
            )

    def collect(self, page_size, **params):
        names, number = [], 1
        while True:
            body = self.get(self.user, "servers/", pageSize=page_size, page=number, **params).json()
            self.assertLessEqual(len(body["items"]), page_size)
            names += [item["server"]["name"] for item in body["items"]]
            if number >= body["page"]["pages"]:
                return names, body
            number += 1

    def test_pages_partition_the_result_for_every_ordering_without_repeats_or_gaps(self):
        for sort, direction in itertools.product(("status", "name", "cpu", "memory", "disk", "uptime", "seen"), ("asc", "desc")):
            whole = self.names(self.get(self.user, "servers/", sort=sort, dir=direction, pageSize=200))
            self.assertEqual(len(whole), 23)
            for size in (1, 4, 10, 23):
                paged, _ = self.collect(size, sort=sort, dir=direction)
                self.assertEqual(paged, whole, (sort, direction, size))

    def test_the_page_envelope(self):
        body = self.get(self.user, "servers/", pageSize=10, page=3).json()
        self.assertEqual(body["page"], {"number": 3, "size": 10, "total": 23, "pages": 3})
        self.assertEqual(len(body["items"]), 3)
        body = self.get(self.user, "servers/", pageSize=23).json()
        self.assertEqual(body["page"], {"number": 1, "size": 23, "total": 23, "pages": 1})

    def test_a_page_past_the_end_is_empty_but_still_describes_the_result(self):
        body = self.get(self.user, "servers/", pageSize=10, page=4).json()
        self.assertEqual(body["items"], [])
        self.assertEqual(body["page"], {"number": 4, "size": 10, "total": 23, "pages": 3})
        self.assertEqual(sum(body["counts"].values()), 23)
        self.assertEqual(self.get(self.user, "servers/", page=MAX_PAGE).json()["items"], [])

    def test_the_default_page_size_bounds_the_response(self):
        for i in range(60):
            make_server(f"extra-{i:02d}", now=self.now)
        body = self.get(self.user, "servers/").json()
        self.assertEqual((len(body["items"]), body["page"]["size"], body["page"]["total"], body["page"]["pages"]), (50, 50, 83, 2))

    def test_the_largest_page_size_is_allowed(self):
        self.assertEqual(self.get(self.user, "servers/", pageSize=MAX_PAGE_SIZE).status_code, 200)

    def test_the_total_follows_the_status_filter(self):
        everything = self.get(self.user, "servers/").json()
        for status in ("critical", "warning", "unknown", "healthy"):
            body = self.get(self.user, "servers/", status=status, pageSize=5).json()
            self.assertEqual(body["page"]["total"], everything["counts"][status], status)
            paged, _ = self.collect(5, status=status)
            self.assertEqual(len(paged), everything["counts"][status])

    def test_names_that_differ_only_in_case_still_have_one_stable_order(self):
        """``Web`` and ``web`` are different names for the database but equal for sorting: ids decide, so pages never swap them."""
        for index in range(8, 0, -1):  # inserted in descending id order, so insertion order is not id order
            variant = "".join(char.upper() if (index >> bit) & 1 else char for bit, char in enumerate("srv"))
            make_server(variant, now=self.now, id=fixed(f"{index:x}"))
        for sort in ("name", "status", "cpu", "seen"):
            names, _ = self.collect(3, sort=sort, q="srv")
            whole = self.names(self.get(self.user, "servers/", sort=sort, q="srv", pageSize=200))
            self.assertEqual(names, whole, sort)
            self.assertEqual(len(set(whole)), 8)
        ids = [i["server"]["id"] for i in self.get(self.user, "servers/", sort="name", q="srv", pageSize=200).json()["items"]]
        self.assertEqual(ids, sorted(ids))

    def test_a_page_past_the_end_does_not_query_the_rows(self):
        client = signed_in_client(self.user)
        client.get(API + "servers/")  # warm up
        with CaptureQueriesContext(connection) as past:
            client.get(API + "servers/?page=10000&pageSize=200")
        with CaptureQueriesContext(connection) as first:
            client.get(API + "servers/?page=1&pageSize=200")
        self.assertFalse([q for q in past if "OFFSET" in q["sql"] or "LIMIT 200" in q["sql"]])
        self.assertLess(len(past), len(first))
        with CaptureQueriesContext(connection) as past_containers:
            client.get(API + "containers/?page=10000&pageSize=200")
        self.assertFalse([q for q in past_containers if "LIMIT 200" in q["sql"]])

    def test_containers_page_the_same_way(self):
        server = make_server("host", now=self.now, cpu=None)
        make_docker_host(server, now=self.now)
        for i in range(17):
            make_container(server, f"c-{i:02d}", now=self.now, state="exited" if i % 3 else "running", started_ago=None if i % 4 == 0 else 100 * (i % 3))
        for sort, direction in itertools.product(("status", "name", "server", "started"), ("asc", "desc")):
            whole = [i["container"]["name"] for i in self.get(self.user, "containers/", sort=sort, dir=direction, pageSize=200).json()["items"]]
            self.assertEqual(len(whole), 17)
            paged, number = [], 1
            while True:
                body = self.get(self.user, "containers/", sort=sort, dir=direction, pageSize=4, page=number).json()
                paged += [i["container"]["name"] for i in body["items"]]
                if number >= body["page"]["pages"]:
                    break
                number += 1
            self.assertEqual(paged, whole, (sort, direction))


class ContainerTieBreakTests(ConsoleDataTestCase):
    def test_containers_with_the_same_name_keep_one_stable_order(self):
        user = make_user("ops", all_customers=True)
        servers = [make_server(name, now=self.now, cpu=None) for name in ("h-b", "h-a")]
        for server in servers:
            make_docker_host(server, now=self.now)
            for index in range(6, 0, -1):
                make_container(server, "same", now=self.now, container_id=f"{index:064x}")
        for sort in ("status", "name", "server", "started"):
            for direction in ("asc", "desc"):
                whole = [i["container"]["id"] for i in self.get(user, "containers/", sort=sort, dir=direction, pageSize=200).json()["items"]]
                self.assertEqual(len(set(whole)), 12)
                paged, number = [], 1
                while True:
                    body = self.get(user, "containers/", sort=sort, dir=direction, pageSize=5, page=number).json()
                    paged += [i["container"]["id"] for i in body["items"]]
                    if number >= body["page"]["pages"]:
                        break
                    number += 1
                self.assertEqual(paged, whole, (sort, direction))


class SearchTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        customer = Customer.objects.create(name="Wayne Enterprises")
        gotham = Site.objects.create(customer=customer, name="Gotham Office")
        make_server("alpha", now=self.now, site=gotham, ip_address="10.20.30.40", operating_system="Ubuntu 24.04")
        make_server("beta", now=self.now, site=gotham, ip_address="2001:db8::1", operating_system="Debian 12")
        make_server("a_b", now=self.now, operating_system="Windows Server 2022")
        make_server("axb", now=self.now)
        make_server("100%-cpu", now=self.now)
        make_server("σέρβερ-1", now=self.now)
        self.user = make_user("ops", all_customers=True)

    def found(self, q):
        return sorted(self.names(self.get(self.user, "servers/", q=q)))

    def test_every_field_is_searched(self):
        self.assertEqual(self.found("alpha"), ["alpha"])  # name
        self.assertEqual(self.found("beta.internal"), ["beta"])  # hostname
        self.assertEqual(self.found("10.20.30"), ["alpha"])  # IPv4 fragment
        self.assertEqual(self.found("db8"), ["beta"])  # IPv6 fragment
        self.assertEqual(self.found("ubuntu"), ["alpha"])  # operating system
        self.assertEqual(self.found("gotham"), ["alpha", "beta"])  # site
        self.assertEqual(self.found("wayne"), ["alpha", "beta"])  # customer

    def test_every_word_must_match_but_in_any_field(self):
        self.assertEqual(self.found("wayne ubuntu"), ["alpha"])
        self.assertEqual(self.found("ubuntu debian"), [])
        self.assertEqual(self.found("  gotham    DEBIAN  "), ["beta"])

    def test_the_search_ignores_case(self):
        self.assertEqual(self.found("ALPHA"), ["alpha"])
        self.assertEqual(self.found("WAYNE enterprises"), ["alpha", "beta"])

    def test_wildcards_are_literal(self):
        self.assertEqual(self.found("a_b"), ["a_b"])
        self.assertEqual(self.found("_"), ["a_b"])
        self.assertEqual(self.found("%"), ["100%-cpu"])
        self.assertEqual(self.found("\\"), [])

    def test_non_ascii_text_is_searched(self):
        self.assertEqual(self.found("σέρβερ"), ["σέρβερ-1"])

    def test_the_search_is_not_normalised_so_text_copied_from_the_ui_matches_as_stored(self):
        make_server("Srv™", now=self.now)
        make_server("ceph²", now=self.now)
        make_server("ﬁle-1", now=self.now)  # a ligature
        make_server("ＦＵＬＬ-width", now=self.now)
        make_server("plain", now=self.now, operating_system="Ⅱ")
        for term, expected in (("Srv™", ["Srv™"]), ("™", ["Srv™"]), ("ceph²", ["ceph²"]), ("ﬁle", ["ﬁle-1"]), ("ＦＵＬＬ", ["ＦＵＬＬ-width"]), ("Ⅱ", ["plain"])):
            self.assertEqual(self.found(term), expected, term)

    def test_servers_without_a_site_are_found_by_their_own_fields(self):
        self.assertEqual(self.found("windows"), ["a_b"])
        self.assertEqual(self.found("axb"), ["axb"])

    def test_sql_metacharacters_are_data(self):
        for term in ("'; DROP TABLE infrastructure_server; --", '" OR 1=1 --', "a' OR '1'='1", ")) UNION SELECT"):
            self.assertEqual(self.found(term), [], term)
        self.assertEqual(self.get(self.user, "servers/").json()["page"]["total"], 6)

    def test_an_empty_or_blank_search_matches_everything(self):
        for q in ("", "   ", "\t \n"):
            self.assertEqual(len(self.found(q)), 6, repr(q))

    def test_containers_are_searched_by_name_image_docker_id_server_site_and_customer(self):
        server = Site.objects.get(name="Gotham Office").servers.get(name="alpha")
        make_docker_host(server, now=self.now)
        make_container(server, "nginx-front", now=self.now, image="registry.example/web:2.1", container_id="abcdef0123456789" * 4)
        make_container(server, "redis", now=self.now, image="redis:7")

        def found(q):
            body = self.get(self.user, "containers/", q=q).json()
            return sorted(i["container"]["name"] for i in body["items"])

        self.assertEqual(found("nginx"), ["nginx-front"])
        self.assertEqual(found("registry.example"), ["nginx-front"])
        self.assertEqual(found("abcdef01"), ["nginx-front"])
        self.assertEqual(found("alpha"), ["nginx-front", "redis"])
        self.assertEqual(found("gotham"), ["nginx-front", "redis"])
        self.assertEqual(found("wayne redis"), ["redis"])


class ContainerListTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.user = make_user("ops", all_customers=True)
        self.web = make_server("web", now=self.now, cpu=None)
        self.db = make_server("db", now=self.now, cpu=None)
        for server in (self.web, self.db):
            make_docker_host(server, now=self.now)
        make_container(self.web, "app", now=self.now, health="healthy", started_ago=100)
        make_container(self.web, "dead-one", now=self.now, state="dead", started_ago=None)
        make_container(self.db, "postgres", now=self.now, health="unhealthy", started_ago=500)
        make_container(self.db, "migrate", now=self.now, state="exited", started_ago=900)

    def names_of(self, **params):
        return [i["container"]["name"] for i in self.get(self.user, "containers/", **params).json()["items"]]

    def test_the_default_order_is_worst_first_then_name_then_server(self):
        self.assertEqual(self.names_of(), ["dead-one", "postgres", "migrate", "app"])

    def test_sorting(self):
        self.assertEqual(self.names_of(sort="name"), ["app", "dead-one", "migrate", "postgres"])
        self.assertEqual(self.names_of(sort="name", dir="desc"), ["postgres", "migrate", "dead-one", "app"])
        self.assertEqual(self.names_of(sort="server"), ["migrate", "postgres", "app", "dead-one"])  # db before web
        self.assertEqual(self.names_of(sort="started"), ["app", "postgres", "migrate", "dead-one"])  # newest first, unknown last
        self.assertEqual(self.names_of(sort="started", dir="asc"), ["migrate", "postgres", "app", "dead-one"])

    def test_filters(self):
        self.assertEqual(self.names_of(status="critical"), ["dead-one", "postgres"])
        self.assertEqual(self.names_of(status="idle"), ["migrate"])
        self.assertEqual(self.names_of(status="healthy"), ["app"])
        self.assertEqual(self.names_of(server=self.db.pk), ["postgres", "migrate"])
        self.assertEqual(self.names_of(server=self.db.pk, status="idle"), ["migrate"])

    def test_the_counts_ignore_the_status_and_follow_the_server_filter(self):
        body = self.get(self.user, "containers/", status="critical", server=self.db.pk).json()
        self.assertEqual(body["counts"], {"critical": 1, "warning": 0, "unknown": 0, "idle": 1, "healthy": 0})
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (1, 2))

    def test_an_item_says_where_the_container_runs(self):
        customer = Customer.objects.create(name="Acme")
        site = Site.objects.create(customer=customer, name="HQ")
        self.web.site = site
        self.web.save()
        body = self.get(self.user, "containers/", q="app").json()
        self.assertEqual(body["items"][0]["serverName"], "web")
        self.assertEqual((body["items"][0]["customerName"], body["items"][0]["siteName"]), ("Acme", "HQ"))
        unplaced = self.get(self.user, "containers/", q="postgres").json()["items"][0]
        self.assertEqual(unplaced["serverName"], "db")
        self.assertNotIn("siteName", unplaced)
        self.assertNotIn("customerName", unplaced)

    def test_the_container_id_is_unique_across_servers_and_stable(self):
        shared = "f" * 64
        make_container(self.web, "twin", now=self.now, container_id=shared)
        make_container(self.db, "twin", now=self.now, container_id=shared)
        ids = [i["container"]["id"] for i in self.get(self.user, "containers/", q="twin").json()["items"]]
        self.assertEqual(sorted(ids), sorted([f"{self.web.pk}:{shared}", f"{self.db.pk}:{shared}"]))

    def test_the_started_time_is_kept_even_for_containers_of_a_silent_host(self):
        self.web.last_seen_at = self.now - timedelta(hours=1)
        self.web.save()
        item = self.get(self.user, "containers/", q="app").json()["items"][0]
        self.assertEqual((item["container"]["state"], item["status"]), ("unknown", "unknown"))
        self.assertTrue(item["container"]["startedAt"].endswith("Z"))


# Query strings every list endpoint must refuse, and how.
BAD_QUERIES = {
    "page=0": "invalid_parameter",
    "page=-1": "invalid_parameter",
    "page=abc": "invalid_parameter",
    "page=1.5": "invalid_parameter",
    "page=%2B1": "invalid_parameter",  # "+1"
    "page=1_0": "invalid_parameter",
    "page=%D9%A1": "invalid_parameter",  # an Arabic-Indic digit one
    "page=": "invalid_parameter",
    f"page={MAX_PAGE + 1}": "invalid_parameter",
    "page=99999999999999999999": "invalid_parameter",
    "pageSize=0": "invalid_parameter",
    "pageSize=-5": "invalid_parameter",
    f"pageSize={MAX_PAGE_SIZE + 1}": "invalid_parameter",
    "pageSize=ten": "invalid_parameter",
    "sort=bogus": "invalid_parameter",
    "sort=": "invalid_parameter",
    "sort=NAME": "invalid_parameter",
    "dir=up": "invalid_parameter",
    "dir=": "invalid_parameter",
    "status=bogus": "invalid_parameter",
    "status=CRITICAL": "invalid_parameter",
    "status=": "invalid_parameter",
    "customer=not-a-uuid": "invalid_parameter",
    "customer=": "invalid_parameter",
    "site=1": "invalid_parameter",
    "site=%7B00000000-0000-0000-0000-000000000001%7D": "invalid_parameter",  # braces
    "site=00000000000000000000000000000001": "invalid_parameter",  # no hyphens
    "site=urn:uuid:00000000-0000-0000-0000-000000000001": "invalid_parameter",
    "q=%00": "invalid_parameter",
    "q=a%00b": "invalid_parameter",
    "q=%07": "invalid_parameter",
    f"q={'x' * (MAX_SEARCH_LENGTH + 1)}": "invalid_parameter",
    f"q={'+'.join('w' * 3 for _ in range(MAX_SEARCH_WORDS + 1))}": "invalid_parameter",
    "unknown=1": "unknown_parameter",
    "Page=1": "unknown_parameter",
    "sit=00000000-0000-0000-0000-000000000001": "unknown_parameter",
    "page=1&page=2": "invalid_parameter",
    "status=healthy&status=critical": "invalid_parameter",
    "q=a&q=b": "invalid_parameter",
    "q[]=a": "unknown_parameter",
    "page[0]=1": "unknown_parameter",
}
CONTAINER_ONLY = {
    "server=nope": "invalid_parameter",
    "server=": "invalid_parameter",
    "server=1": "invalid_parameter",
}


class InvalidInputTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        make_server("one", now=self.now)
        self.clients = [signed_in_client(make_user("ops", all_customers=True)), signed_in_client(make_user("acme", customers=[Customer.objects.create(name="C")]))]

    def check(self, path, query, code):
        for client in self.clients:
            response = client.get(f"{API}{path}?{query}")
            self.assertEqual(response.status_code, 400, (path, query, response.content[:200]))
            body = response.json()
            self.assertEqual(body["error"]["code"], code, (path, query))
            self.assertEqual(response["Content-Type"], "application/json")
            # What was sent is not echoed back.
            decoded = query.split("=", 1)[-1]
            if len(decoded) > 6 and "%" not in decoded:
                self.assertNotIn(decoded, response.content.decode())

    def test_the_server_list_refuses_bad_queries(self):
        for query, code in BAD_QUERIES.items():
            self.check("servers/", query, code)

    def test_the_container_list_refuses_bad_queries(self):
        for query, code in {**BAD_QUERIES, **CONTAINER_ONLY}.items():
            self.check("containers/", query, code)

    def test_idle_is_a_container_status_but_not_a_server_status(self):
        self.check("servers/", "status=idle", "invalid_parameter")
        self.assertEqual(self.clients[0].get(f"{API}containers/?status=idle").status_code, 200)

    def test_container_only_parameters_are_unknown_to_the_server_list(self):
        self.check("servers/", "server=00000000-0000-0000-0000-000000000001", "unknown_parameter")

    def test_the_detail_view_takes_no_parameters(self):
        server = self.clients[0].get(f"{API}servers/").json()["items"][0]["server"]["id"]
        response = self.clients[0].get(f"{API}servers/{server}/?page=2")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "unknown_parameter"))

    def test_a_path_that_is_not_a_uuid_is_a_json_404(self):
        for path in ("servers/1/", "servers/not-a-uuid/", "servers/%00/", "servers/../", "servers//", "containers/1/"):
            response = self.clients[0].get(API + path)
            self.assertEqual(response.status_code, 404, path)
            self.assertEqual(response["Content-Type"], "application/json")

    def test_malformed_input_is_always_a_client_error_never_a_server_error(self):
        nasty = ["%ff%fe", "%ED%A0%80", "%C0%AF", "💥", "a" * 5000, "%00" * 10, "\\u0000", "{{7*7}}", "<script>alert(1)</script>"]
        for path in ("servers/", "containers/"):
            for value in nasty:
                for name in ("q", "status", "sort", "dir", "page", "pageSize", "customer", "site"):
                    response = self.clients[0].get(f"{API}{path}?{name}={quote(value, safe='%')}")
                    self.assertLess(response.status_code, 500, (path, name, value))
                    self.assertEqual(response["Content-Type"], "application/json")
