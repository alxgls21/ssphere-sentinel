"""The server and container endpoints do a constant amount of work per request and use the indexes.

Query counts are compared between a small and a large estate (an N+1 would grow
with the rows on the page), and the plans of the real statements are checked
on an estate large enough that a table scan would be the wrong answer for a
user who may see one customer.
"""

import uuid
from datetime import timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.console.tests.helpers import (
    API,
    ConsoleDataTestCase,
    make_container,
    make_docker_host,
    make_server,
    make_user,
    signed_in_client,
)
from apps.infrastructure.models import DockerContainer, DockerHostState, Server, ServerTelemetry
from apps.inventory.models import Customer, Site


def count_queries(client, path):
    """``(all queries, queries on the monitoring tables)`` one request makes, after a warm-up request."""
    client.get(API + path)  # warm up: session, permissions
    with CaptureQueriesContext(connection) as queries:
        response = client.get(API + path)
    assert response.status_code == 200, response.content[:200]
    sql = [q["sql"] for q in queries]
    return len(sql), len([q for q in sql if "infrastructure_" in q])


class QueryCountTests(ConsoleDataTestCase):
    def grow(self, servers, containers_each, *, start):
        customer = Customer.objects.get_or_create(name="Acme")[0]
        site = Site.objects.get_or_create(customer=customer, name="HQ")[0]
        for i in range(start, start + servers):
            server = make_server(f"srv-{i:03d}", site=site, now=self.now, cpu=10 + i % 90)
            make_docker_host(server, now=self.now)
            for j in range(containers_each):
                make_container(server, f"c-{j}", now=self.now, state=("running", "exited", "dead")[j % 3])

    def paths(self):
        server = Server.objects.order_by("name").first()
        return ["servers/", "servers/?q=srv&sort=cpu&status=healthy", f"servers/{server.pk}/", "containers/", "containers/?q=c-&sort=server"]

    def test_the_number_of_queries_does_not_depend_on_the_number_of_rows(self):
        self.grow(2, 2, start=0)
        users = {
            "all": make_user("all", all_customers=True),
            "acme": make_user("acme", customers=[Customer.objects.get(name="Acme")]),
        }
        small = {
            (who, path): count_queries(signed_in_client(user), path) for who, user in users.items() for path in self.paths()
        }
        self.grow(40, 6, start=2)
        large = {
            (who, path): count_queries(signed_in_client(user), path) for who, user in users.items() for path in self.paths()
        }
        self.assertEqual(small, large)

    def test_a_list_page_takes_a_handful_of_queries(self):
        self.grow(30, 3, start=0)
        user = make_user("all", all_customers=True)
        client = signed_in_client(user)
        # Queries on the monitoring tables: the counts per status, the page, and the
        # per-server container counts (the size of the scope is a fourth when searching).
        self.assertEqual(count_queries(client, "servers/")[1], 3)
        self.assertEqual(count_queries(client, "servers/?q=srv")[1], 4)
        self.assertEqual(count_queries(client, "containers/")[1], 2)
        self.assertEqual(count_queries(client, f"servers/{Server.objects.first().pk}/")[1], 3)
        # A restricted user costs one more query in all: the visible sites, read once per request.
        restricted = signed_in_client(make_user("acme", customers=[Customer.objects.get(name="Acme")]))
        everyone = count_queries(client, "servers/")[0]
        self.assertEqual(count_queries(restricted, "servers/")[0], everyone + 1)

    def test_pages_do_not_load_more_than_a_page(self):
        self.grow(60, 1, start=0)
        client = signed_in_client(make_user("all", all_customers=True))
        for path, marker in (("servers/?pageSize=10", '"hostname"'), ("containers/?pageSize=10", '"container_id"')):
            client.get(API + path)  # warm up
            with CaptureQueriesContext(connection) as queries:
                response = client.get(API + path)
            self.assertEqual(len(response.json()["items"]), 10)
            # The only statements that read row columns are limited to the page.
            reading = [q["sql"] for q in queries if marker in q["sql"].split(" FROM ")[0]]
            self.assertEqual(len(reading), 1, reading)
            self.assertTrue(reading[0].rstrip().endswith("LIMIT 10"), reading[0][-80:])

    def test_a_scope_does_not_cost_a_second_lookup_of_the_visible_sites(self):
        customer = Customer.objects.create(name="Acme")
        site = Site.objects.create(customer=customer, name="HQ")
        server = make_server("s", site=site, now=self.now)
        make_docker_host(server, now=self.now)
        make_container(server, "c", now=self.now)
        client = signed_in_client(make_user("acme", customers=[customer]))
        for path in ("servers/", f"servers/?customer={customer.pk}", f"servers/?site={site.pk}&q=s", f"containers/?site={site.pk}"):
            client.get(API + path)
            with CaptureQueriesContext(connection) as queries:
                self.assertEqual(client.get(API + path).status_code, 200)
            lookups = [q for q in queries if "FROM \"inventory_site\"" in q["sql"] and "infrastructure_" not in q["sql"]]
            # one to check a scope against the grants, one to list the visible sites; never more
            self.assertLessEqual(len(lookups), 2 if "customer=" in path or "site=" in path else 1, (path, [q["sql"][:80] for q in lookups]))


def explain(sql: str, *, seqscan: bool = True) -> str:
    """The plan of ``sql``; with ``seqscan=False`` the planner is told to avoid table scans where it can."""
    with connection.cursor() as cursor:
        cursor.execute(f"SET LOCAL enable_seqscan = {'on' if seqscan else 'off'}")
        try:
            cursor.execute("EXPLAIN " + sql)
            return "\n".join(row[0] for row in cursor.fetchall())
        finally:
            cursor.execute("RESET enable_seqscan")


class PlanTests(ConsoleDataTestCase):
    """An estate where one customer is 1% of the data: its users' queries must not scan everything."""

    CUSTOMERS = 100
    SITES_PER_CUSTOMER = 10
    SERVERS_PER_SITE = 10
    CONTAINERS_PER_SERVER = 3

    @classmethod
    def setUpTestData(cls):
        from django.utils import timezone

        now = timezone.now()
        customers = Customer.objects.bulk_create(Customer(name=f"C{i:03d}") for i in range(cls.CUSTOMERS))
        sites = Site.objects.bulk_create(
            Site(customer=customer, name=f"S{j}") for customer in customers for j in range(cls.SITES_PER_CUSTOMER)
        )
        servers = Server.objects.bulk_create(
            Server(
                name=f"srv-{site.customer.name}-{site.name}-{k}",
                hostname=f"h{k}",
                site=site,
                status="online",
                last_seen_at=now - timedelta(seconds=k * 20),
            )
            for site in sites
            for k in range(cls.SERVERS_PER_SITE)
        )
        ServerTelemetry.objects.bulk_create(
            ServerTelemetry(
                server=server,
                cpu_percent=i % 100,
                memory_total_bytes=1,
                memory_used_bytes=1,
                memory_percent=i % 97,
                disk_total_bytes=1,
                disk_used_bytes=1,
                disk_percent=i % 89,
                uptime_seconds=i,
                collected_at=now,
                received_at=now,
            )
            for i, server in enumerate(servers)
        )
        DockerHostState.objects.bulk_create(
            DockerHostState(server=server, available=True, status="available", collected_at=now, received_at=now, last_discovered_at=now)
            for server in servers
        )
        DockerContainer.objects.bulk_create(
            DockerContainer(
                server=server,
                container_id=uuid.uuid4().hex,
                name=f"c{j}",
                image="img",
                state="running" if j else "exited",
                health="none",
                last_seen_at=now,
                received_at=now,
            )
            for server in servers
            for j in range(cls.CONTAINERS_PER_SERVER)
        )
        with connection.cursor() as cursor:
            cursor.execute("ANALYZE")
        cls.customer = customers[7]

    def statements(self, user, path):
        client = signed_in_client(user)
        client.get(API + path)
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(client.get(API + path).status_code, 200)
        return [q["sql"] for q in queries if "infrastructure_" in q["sql"]]

    def test_a_restricted_users_server_queries_can_use_the_site_index(self):
        """With table scans discouraged the plan must still be able to use ``site_id``: the choice
        itself depends on statistics and settings (and on the PostgreSQL version), the index must exist
        and fit the condition. At realistic sizes the planner does choose it (see the Phase 1 report)."""
        user = make_user("one-customer", customers=[self.customer])
        for path in ("servers/", "servers/?q=srv&sort=cpu&status=healthy", "servers/?sort=seen&dir=desc"):
            seen = 0
            for sql in self.statements(user, path):
                if '"infrastructure_server"' not in sql or '"infrastructure_dockercontainer"' in sql:
                    continue
                seen += 1
                plan = explain(sql, seqscan=False)
                self.assertNotIn("Seq Scan on infrastructure_server ", plan, (path, plan))
                self.assertIn("infrastructure_server_site_id", plan, (path, plan))
            self.assertGreater(seen, 0, path)

    def test_a_restricted_users_container_queries_can_reach_the_containers_through_the_index(self):
        """This estate is too small for the planner to prefer an index over scanning 30k rows (it is right
        not to); with table scans discouraged, the plan shows the index is there and fits the join."""
        user = make_user("one-customer", customers=[self.customer])
        for path in ("servers/", "containers/", "containers/?status=critical&sort=server", "containers/?q=c1"):
            seen = 0
            for sql in self.statements(user, path):
                if '"infrastructure_dockercontainer"' not in sql:
                    continue
                seen += 1
                plan = explain(sql, seqscan=False)
                self.assertNotIn("Seq Scan on infrastructure_dockercontainer", plan, (path, plan))
                self.assertRegex(plan, r"Index (Only )?Scan using |Bitmap Index Scan on ", plan)
            self.assertGreater(seen, 0, path)

    def test_a_site_scope_is_as_selective_as_a_site_grant(self):
        user = make_user("all", all_customers=True)
        site = Site.objects.filter(customer=self.customer).first()
        for sql in self.statements(user, f"servers/?site={site.pk}"):
            if '"infrastructure_server"' in sql and "LIMIT" in sql:
                self.assertNotIn("Seq Scan on infrastructure_server ", explain(sql, seqscan=False))

    def test_the_whole_estate_is_served_in_bounded_pages(self):
        user = make_user("all", all_customers=True)
        body = signed_in_client(user).get(API + "servers/?pageSize=200").json()
        self.assertEqual(body["page"]["total"], self.CUSTOMERS * self.SITES_PER_CUSTOMER * self.SERVERS_PER_SITE)
        self.assertEqual(len(body["items"]), 200)
        self.assertEqual(sum(body["counts"].values()), body["page"]["total"])
