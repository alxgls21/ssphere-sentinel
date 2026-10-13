"""The ``site`` link of servers and network targets: the migration, the constraints, the admin."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.models import ProtectedError
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.console.tests.helpers import PINNED, make_user, signed_in_client
from apps.infrastructure.models import Server
from apps.inventory.models import Customer, Site
from apps.network.models import NetworkTarget


class SiteLinkModelTests(TestCase):
    def setUp(self):
        self.customer = Customer.objects.create(name="Acme")
        self.site = Site.objects.create(customer=self.customer, name="HQ")

    def test_the_site_is_optional(self):
        server = Server.objects.create(name="s", hostname="s.local")
        target = NetworkTarget.objects.create(name="t", hostname_or_ip="192.0.2.1", protocol="icmp")
        self.assertIsNone(server.site)
        self.assertIsNone(target.site)

    def test_a_site_knows_its_servers_and_targets(self):
        server = Server.objects.create(name="s", hostname="s.local", site=self.site)
        target = NetworkTarget.objects.create(name="t", hostname_or_ip="192.0.2.1", protocol="icmp", site=self.site)
        self.assertEqual(list(self.site.servers.all()), [server])
        self.assertEqual(list(self.site.network_targets.all()), [target])

    def test_a_site_that_still_has_servers_or_targets_cannot_be_deleted(self):
        Server.objects.create(name="s", hostname="s.local", site=self.site)
        with self.assertRaises(ProtectedError):
            self.site.delete()
        Server.objects.all().delete()
        NetworkTarget.objects.create(name="t", hostname_or_ip="192.0.2.1", protocol="icmp", site=self.site)
        with self.assertRaises(ProtectedError):
            self.site.delete()
        NetworkTarget.objects.all().delete()
        self.site.delete()  # nothing left: allowed

    def test_the_site_is_indexed_for_the_visibility_filter(self):
        with connection.cursor() as cursor:
            for table in ("infrastructure_server", "network_networktarget"):
                indexes = connection.introspection.get_constraints(cursor, table)
                self.assertTrue(
                    any(info["index"] and info["columns"] == ["site_id"] for info in indexes.values()),
                    f"{table} has no index on site_id",
                )

    def test_a_heartbeat_does_not_touch_the_site(self):
        server = Server.objects.create(name="s", hostname="s.local", site=self.site)
        _agent, token = create_agent(server=server, name="agent")
        response = Client().post(
            "/api/v1/agent/heartbeat/", data="{}", content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}"
        )
        self.assertEqual(response.status_code, 200)
        server.refresh_from_db()
        self.assertEqual(server.site, self.site)
        self.assertIsNotNone(server.last_seen_at)

    @PINNED
    def test_a_server_enrolled_by_an_agent_is_private_until_someone_assigns_it(self):
        """The whole path an existing agent takes: enrol, report, then who can see it."""
        server = Server.objects.create(name="new-host", hostname="new-host.local")
        _agent, token = create_agent(server=server, name="new-agent")
        Client().post("/api/v1/agent/heartbeat/", data="{}", content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}")
        restricted = signed_in_client(make_user("acme", customers=[self.customer]))
        everyone = signed_in_client(make_user("all", all_customers=True))
        names = lambda client: [i["server"]["name"] for i in client.get("/api/v1/console/servers/").json()["items"]]  # noqa: E731
        self.assertEqual(names(restricted), [])
        self.assertEqual(names(everyone), ["new-host"])
        server.refresh_from_db()
        server.site = self.site
        server.save()
        self.assertEqual(names(restricted), ["new-host"])


class SiteLinkMigrationTests(TransactionTestCase):
    """Existing servers and targets survive the migration and start out unassigned."""

    before = [("infrastructure", "0004_docker_last_discovered_at"), ("network", "0003_preserve_history_on_agent_delete")]
    after = [("infrastructure", "0005_site_link"), ("network", "0004_site_link")]

    def migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(targets)
        return executor.loader.project_state(targets).apps

    def tearDown(self):
        # Leave the database as the other tests expect it: every migration applied, including
        # any added after these two (a fixed target would roll those back and not re-apply them).
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_rows_that_exist_before_the_migration_are_kept_and_unassigned(self):
        old = self.migrate(self.before)
        OldServer = old.get_model("infrastructure", "Server")
        OldTarget = old.get_model("network", "NetworkTarget")
        self.assertFalse(any(f.name == "site" for f in OldServer._meta.get_fields()))
        now = timezone.now()
        server = OldServer.objects.create(name="legacy", hostname="legacy.local", last_seen_at=now - timedelta(minutes=1), status="online")
        target = OldTarget.objects.create(name="legacy-target", hostname_or_ip="192.0.2.9", protocol="icmp", customer_name="Acme (free text)")

        new = self.migrate(self.after)
        NewServer = new.get_model("infrastructure", "Server")
        NewTarget = new.get_model("network", "NetworkTarget")
        migrated = NewServer.objects.get(pk=server.pk)
        self.assertEqual((migrated.name, migrated.hostname, migrated.status, migrated.last_seen_at), ("legacy", "legacy.local", "online", server.last_seen_at))
        self.assertIsNone(migrated.site_id)
        kept = NewTarget.objects.get(pk=target.pk)
        self.assertEqual((kept.name, kept.customer_name), ("legacy-target", "Acme (free text)"))
        self.assertIsNone(kept.site_id)  # the free-text customer name is never turned into access

    def test_the_migration_can_be_reversed_without_losing_the_servers(self):
        new = self.migrate(self.after)
        customer = new.get_model("inventory", "Customer").objects.create(name="Acme")
        site = new.get_model("inventory", "Site").objects.create(customer=customer, name="HQ")
        new.get_model("infrastructure", "Server").objects.create(name="kept", hostname="kept.local", site=site)
        old = self.migrate(self.before)
        self.assertEqual(list(old.get_model("infrastructure", "Server").objects.values_list("name", flat=True)), ["kept"])

    def test_the_migration_is_a_single_nullable_column_and_an_index(self):
        """No table rewrite and no default: adding the column does not lock or touch existing rows."""
        executor = MigrationExecutor(connection)
        for app, name in self.after:
            migration = executor.loader.get_migration(app, name)
            self.assertEqual([type(op).__name__ for op in migration.operations], ["AddField"])
            self.assertTrue(migration.operations[0].field.null)
            self.assertIsNone(migration.operations[0].field.default if migration.operations[0].field.has_default() else None)


@PINNED
class SiteAdminTests(TestCase):
    def setUp(self):
        self.admin = make_user("root", console=False, superuser=True)
        self.client = Client()
        self.client.force_login(self.admin)
        self.customer = Customer.objects.create(name="Acme")
        self.site = Site.objects.create(customer=self.customer, name="HQ")
        self.placed = Server.objects.create(name="placed", hostname="p.local", site=self.site)
        self.loose = Server.objects.create(name="loose", hostname="l.local")
        self.target = NetworkTarget.objects.create(name="t", hostname_or_ip="192.0.2.1", protocol="icmp")

    def test_the_server_pages_show_the_site(self):
        changelist = self.client.get(reverse("admin:infrastructure_server_changelist"))
        self.assertEqual(changelist.status_code, 200)
        self.assertContains(changelist, "Acme / HQ")
        form = self.client.get(reverse("admin:infrastructure_server_change", args=[self.loose.pk]))
        self.assertEqual(form.status_code, 200)
        self.assertContains(form, "Placement")
        self.assertContains(form, "without a site is visible only to users who may see all customers")

    def test_servers_without_a_site_can_be_listed(self):
        response = self.client.get(reverse("admin:infrastructure_server_changelist"), {"site__isempty": "1"})
        self.assertEqual(response.status_code, 200)
        names = [s.name for s in response.context["cl"].result_list]
        self.assertEqual(names, ["loose"])

    def test_a_server_is_assigned_from_its_form(self):
        url = reverse("admin:infrastructure_server_change", args=[self.loose.pk])
        data = {
            "name": "loose", "hostname": "l.local", "description": "", "operating_system": "", "ip_address": "",
            "site": str(self.site.pk), "status": "unknown", "last_seen_at_0": "", "last_seen_at_1": "",
        }
        # The page also carries the inline formsets (telemetry, Docker state, containers): none edited.
        for formset in self.client.get(url).context["inline_admin_formsets"]:
            prefix = formset.formset.prefix
            data.update({f"{prefix}-TOTAL_FORMS": "0", f"{prefix}-INITIAL_FORMS": "0", f"{prefix}-MIN_NUM_FORMS": "0", f"{prefix}-MAX_NUM_FORMS": "1000"})
        response = self.client.post(url, data)
        self.assertEqual(response.status_code, 302, response.context["adminform"].form.errors if response.context else response.content[:300])
        self.loose.refresh_from_db()
        self.assertEqual(self.loose.site, self.site)

    def test_several_servers_are_placed_from_the_list(self):
        other = Server.objects.create(name="loose-2", hostname="l2.local")
        self.client.get(reverse("admin:infrastructure_server_changelist"))
        rows = sorted([self.loose, other, self.placed], key=lambda s: s.name)  # the list is ordered by name
        data = {"form-TOTAL_FORMS": str(len(rows)), "form-INITIAL_FORMS": str(len(rows)), "form-MIN_NUM_FORMS": "0", "form-MAX_NUM_FORMS": "1000", "_save": "Save"}
        for index, server in enumerate(rows):
            data[f"form-{index}-id"] = str(server.pk)
            data[f"form-{index}-site"] = str(self.site.pk)
        response = self.client.post(reverse("admin:infrastructure_server_changelist"), data)
        self.assertEqual(response.status_code, 302, response.content[:300])
        self.assertEqual(set(Server.objects.values_list("site_id", flat=True)), {self.site.pk})

    def test_several_targets_are_placed_from_the_list(self):
        other = NetworkTarget.objects.create(name="u", hostname_or_ip="192.0.2.3", protocol="icmp")
        rows = sorted([self.target, other], key=lambda t: t.name)
        data = {"form-TOTAL_FORMS": "2", "form-INITIAL_FORMS": "2", "form-MIN_NUM_FORMS": "0", "form-MAX_NUM_FORMS": "1000", "_save": "Save"}
        for index, target in enumerate(rows):
            data[f"form-{index}-id"] = str(target.pk)
            data[f"form-{index}-site"] = str(self.site.pk)
        response = self.client.post(reverse("admin:network_networktarget_changelist"), data)
        self.assertEqual(response.status_code, 302, response.content[:300])
        self.assertEqual(set(NetworkTarget.objects.values_list("site_id", flat=True)), {self.site.pk})

    def test_the_target_pages_show_and_filter_by_site(self):
        self.target.site = self.site
        self.target.save()
        NetworkTarget.objects.create(name="loose-target", hostname_or_ip="192.0.2.2", protocol="icmp")
        changelist = self.client.get(reverse("admin:network_networktarget_changelist"))
        self.assertContains(changelist, "Acme / HQ")
        unplaced = self.client.get(reverse("admin:network_networktarget_changelist"), {"site__isempty": "1"})
        self.assertEqual([t.name for t in unplaced.context["cl"].result_list], ["loose-target"])
        add = self.client.get(reverse("admin:network_networktarget_add"))
        self.assertEqual(add.status_code, 200)
        self.assertContains(add, 'name="site"')

    def test_the_site_search_works_for_the_autocomplete(self):
        response = self.client.get(
            reverse("admin:autocomplete"),
            {"term": "Acme", "app_label": "infrastructure", "model_name": "server", "field_name": "site"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([r["text"] for r in response.json()["results"]], ["Acme / HQ"])
