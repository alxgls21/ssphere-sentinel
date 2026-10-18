"""Alert rules in the console API: who may see and change them, what they say, validation, and concurrency."""

import json
import threading

from django.contrib.auth.models import Permission
from django.db import connection
from django.test import Client, TestCase, TransactionTestCase

from apps.alerts.models import AlertRule, ConfigurationEvent, Incident
from apps.alerts.tests.fleet import PINNED, Fleet, evaluate
from apps.alerts.tests.helpers import make_rule, open_incident
from apps.console.tests.helpers import API, make_user, signed_in_client
from apps.inventory.models import Customer, Site

RULES = API + "alert-rules/"
OPTIONS = RULES + "options/"
DEFAULT_KEYS = {"server-offline", "target-failing", "device-unreachable", "container-failed"}
ITEM_KEYS = {
    "id", "key", "name", "description", "enabled", "kind", "condition", "health", "reason", "severity",
    "activationSeconds", "recoverySeconds", "scope", "openIncidents", "createdAt", "updatedAt", "version", "canEdit",
}


def grant(user, *codenames: str):
    for codename in codenames:
        app, _, name = codename.partition(".")
        user.user_permissions.add(Permission.objects.get(content_type__app_label=app, codename=name))
    return type(user).objects.get(pk=user.pk)


def rule_admin(name: str = "rules-admin", **options):
    return grant(make_user(name, all_customers=True, **options), "alerts.view_alertrule", "alerts.add_alertrule", "alerts.change_alertrule")


def post(client: Client, path: str, body, **extra):
    return client.post(path, json.dumps(body), content_type="application/json", **extra)


def patch(client: Client, path: str, body, **extra):
    return client.patch(path, json.dumps(body), content_type="application/json", **extra)


VALID = {"name": "Interface down", "kind": "interface", "health": "warning", "reason": "down", "severity": "warning"}


class PermissionTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.admin = rule_admin()
        self.viewer = grant(make_user("viewer", all_customers=True), "alerts.view_alertrule")
        self.adder = grant(make_user("adder", all_customers=True), "alerts.add_alertrule")
        self.restricted = grant(
            make_user("restricted", customers=[self.acme]),
            "alerts.view_alertrule", "alerts.add_alertrule", "alerts.change_alertrule",
        )
        self.plain = make_user("plain", all_customers=True)
        self.root = make_user("root", superuser=True)
        self.rule = AlertRule.objects.get(key="server-offline")

    def test_rule_management_needs_global_visibility_and_the_model_permissions(self):
        detail = f"{RULES}{self.rule.pk}/"
        cases = (
            (self.admin, 200, 201, 200, 200),
            (self.root, 200, 201, 200, 200),
            (self.viewer, 200, 403, 403, 200),
            (self.adder, 403, 201, 403, 200),
            (self.restricted, 403, 403, 403, 403),  # every permission, not every customer
            (self.plain, 403, 403, 403, 403),
        )
        for index, (user, read, create, change, options) in enumerate(cases):
            with self.subTest(user=user.username):
                client = signed_in_client(user)
                self.assertEqual(client.get(RULES).status_code, read)
                self.assertEqual(client.get(detail).status_code, read)
                self.assertEqual(client.get(OPTIONS).status_code, options)
                self.assertEqual(post(client, RULES, {**VALID, "name": f"Rule {index}"}).status_code, create)
                version = AlertRule.objects.get(pk=self.rule.pk).version
                response = patch(client, detail, {"version": version, "activationSeconds": 60 + index})
                self.assertEqual(response.status_code, change)
                if change == 403:
                    self.assertEqual(response.json()["error"]["code"], "forbidden")

    def test_signed_out_or_without_the_console_is_refused(self):
        self.assertEqual(Client().get(RULES).status_code, 401)
        no_console = grant(make_user("no-console", console=False, all_customers=True), "alerts.view_alertrule")
        self.assertEqual(signed_in_client(no_console).get(RULES).status_code, 403)

    def test_a_rule_is_never_deleted_here(self):
        response = signed_in_client(self.admin).delete(f"{RULES}{self.rule.pk}/")
        self.assertEqual(response.status_code, 405)
        self.assertEqual(response["Allow"], "GET, HEAD, PATCH")
        self.assertTrue(AlertRule.objects.filter(pk=self.rule.pk).exists())

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.admin, enforce_csrf=True)
        response = post(client, RULES, VALID)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        response = patch(client, f"{RULES}{self.rule.pk}/", {"version": self.rule.version, "enabled": False})
        self.assertEqual(response.status_code, 403)
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(post(client, RULES, VALID, HTTP_X_CSRFTOKEN=token).status_code, 201)
        self.assertTrue(AlertRule.objects.get(pk=self.rule.pk).enabled)


class ListTests(TestCase):
    def setUp(self):
        self.admin = rule_admin()
        self.acme = Customer.objects.create(name="Acme")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.for_acme = make_rule("Acme servers", customer=self.acme, reason="offline", description="the Acme fleet")
        self.for_hq = make_rule("HQ warnings", site=self.hq, health="warning", severity="warning", enabled=False)
        open_incident(self.for_acme)

    def list(self, **params):
        response = signed_in_client(self.admin).get(RULES, params)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_every_rule_with_its_scope_and_open_incidents(self):
        body = self.list()
        self.assertEqual(body["page"], {"number": 1, "size": 50, "total": 6, "pages": 1})
        self.assertEqual((body["counts"], body["scopeTotal"]), ({"enabled": 5, "disabled": 1}, 6))
        items = {item["name"]: item for item in body["items"]}
        self.assertEqual({item["key"] for item in items.values()} - {None}, DEFAULT_KEYS)
        acme = items["Acme servers"]
        self.assertEqual(set(acme), ITEM_KEYS)
        self.assertEqual(acme["scope"], {
            "type": "customer", "customerId": str(self.acme.pk), "customerName": "Acme", "siteId": None, "siteName": None,
        })
        self.assertEqual((acme["openIncidents"], acme["version"], acme["canEdit"], acme["condition"]), (1, 1, True, "health"))
        self.assertEqual(items["HQ warnings"]["scope"], {
            "type": "site", "customerId": str(self.acme.pk), "customerName": "Acme", "siteId": str(self.hq.pk), "siteName": "HQ",
        })
        self.assertEqual(items["Server offline"]["scope"]["type"], "all")
        self.assertIsNone(items["Docker container unhealthy or dead"]["reason"])

    def test_filters_search_sort_and_pages(self):
        self.assertEqual([item["name"] for item in self.list(enabled="disabled")["items"]], ["HQ warnings"])
        self.assertEqual({item["name"] for item in self.list(scope="customer")["items"]}, {"Acme servers"})
        self.assertEqual({item["name"] for item in self.list(scope="site")["items"]}, {"HQ warnings"})
        self.assertEqual(len(self.list(scope="global")["items"]), 4)
        self.assertEqual({item["name"] for item in self.list(q="acme fleet")["items"]}, {"Acme servers"})
        self.assertEqual({item["name"] for item in self.list(q="HQ")["items"]}, {"HQ warnings"})
        self.assertEqual({item["kind"] for item in self.list(kind="device")["items"]}, {"device"})
        self.assertEqual({item["severity"] for item in self.list(severity="warning")["items"]}, {"warning"})
        names = [item["name"] for item in self.list(sort="name", dir="desc")["items"]]
        self.assertEqual(names, sorted(names, key=str.lower, reverse=True))
        paged = self.list(pageSize=4, page=2)
        self.assertEqual((paged["page"]["pages"], len(paged["items"])), (2, 2))
        filtered = self.list(enabled="enabled", kind="server")
        # The counts are over every filter but enabled: the chips stay true.
        self.assertEqual((filtered["counts"], filtered["scopeTotal"]), ({"enabled": 2, "disabled": 1}, 6))

    def test_parameters_are_strict(self):
        client = signed_in_client(self.admin)
        for params in ({"enabled": "maybe"}, {"kind": "printer"}, {"sort": "id"}, {"customer": "x"}, {"pageSize": "500"}):
            with self.subTest(params=params):
                self.assertEqual(client.get(RULES, params).status_code, 400)
        self.assertEqual(client.get(f"{RULES}{self.for_acme.pk}/", {"x": "1"}).status_code, 400)

    def test_the_detail_and_what_a_change_can_do(self):
        response = signed_in_client(self.admin).get(f"{RULES}{self.for_acme.pk}/")
        body = response.json()
        self.assertEqual(body["item"]["name"], "Acme servers")
        self.assertEqual(body["changeEffects"]["enabled"], {"to": False, "closes": "rule_disabled", "which": "all"})
        self.assertEqual(body["changeEffects"]["scope"]["closes"], "out_of_scope")
        self.assertEqual(signed_in_client(self.admin).get(f"{RULES}00000000-0000-0000-0000-000000000000/").status_code, 404)

    def test_the_options_are_what_the_server_accepts(self):
        body = signed_in_client(self.admin).get(OPTIONS).json()
        kinds = {kind["value"]: kind for kind in body["kinds"]}
        self.assertEqual(set(kinds), {"server", "container", "target", "device", "interface"})
        server = {condition["health"]: condition["reasons"] for condition in kinds["server"]["conditions"]}
        self.assertEqual(server["critical"], ["offline", "resources"])
        self.assertIn("status_warning", server["warning"])
        interface = {condition["health"] for condition in kinds["interface"]["conditions"]}
        self.assertNotIn("critical", interface)  # an interface is never critical: not offered
        self.assertEqual(body["limits"]["maxDurationSeconds"], 86_400)
        self.assertEqual(body["defaults"], {"enabled": True, "activationSeconds": 60, "recoverySeconds": 120})
        # Every combination offered is accepted.
        client = signed_in_client(self.admin)
        index = 0
        for kind in body["kinds"]:
            for condition in kind["conditions"]:
                for reason in [None, *condition["reasons"]]:
                    index += 1
                    rule = {"name": f"Combination {index}", "kind": kind["value"], "health": condition["health"],
                            "reason": reason, "severity": "warning"}
                    with self.subTest(rule=rule):
                        self.assertEqual(post(client, RULES, rule).status_code, 201)


class CreateTests(TestCase):
    def setUp(self):
        self.admin = rule_admin()
        self.client_ = signed_in_client(self.admin)
        self.acme = Customer.objects.create(name="Acme")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")

    def errors(self, body, status=400):
        response = post(self.client_, RULES, body)
        self.assertEqual(response.status_code, status, response.content)
        error = response.json()["error"]
        self.assertEqual(error["code"], "validation_error")
        return error["fields"]

    def test_a_rule_is_created_with_the_defaults_and_recorded(self):
        response = post(self.client_, RULES, {**VALID, "name": "  Interface down  ", "siteId": str(self.hq.pk)})
        self.assertEqual(response.status_code, 201)
        item = response.json()["item"]
        self.assertEqual(
            (item["name"], item["enabled"], item["activationSeconds"], item["recoverySeconds"], item["version"]),
            ("Interface down", True, 60, 120, 1),
        )
        self.assertEqual(item["scope"]["siteId"], str(self.hq.pk))
        [event] = ConfigurationEvent.objects.all()
        self.assertEqual(
            (event.action, event.source, event.actor, event.actor_name, event.target_type, event.target_id, event.target_name),
            ("rule_created", "console", self.admin, "rules-admin", "alert_rule", item["id"], "Interface down"),
        )
        self.assertEqual(event.changes["kind"], {"before": None, "after": "interface"})
        self.assertEqual(event.changes["siteId"], {"before": None, "after": str(self.hq.pk)})

    def test_the_optional_fields_are_taken_when_sent(self):
        body = {**VALID, "enabled": False, "activationSeconds": 300, "recoverySeconds": 30, "description": "Uplinks"}
        response = post(self.client_, RULES, body)
        self.assertEqual(response.status_code, 201, response.content)
        item = response.json()["item"]
        self.assertEqual(
            (item["enabled"], item["activationSeconds"], item["recoverySeconds"], item["description"]),
            (False, 300, 30, "Uplinks"),
        )

    def test_the_longest_texts_fit_in_a_body_however_they_are_escaped(self):
        body = {**VALID, "name": "\u03b1" * 255, "description": "\u03b1" * 2000}  # escaped: 6 bytes each
        self.assertGreater(len(json.dumps(body)), 8192)
        self.assertEqual(post(self.client_, RULES, body).status_code, 201)

    def test_what_is_wrong_is_said_field_by_field(self):
        self.assertEqual(self.errors({}), {name: ["Required."] for name in ("health", "kind", "name", "severity")})
        fields = self.errors({**VALID, "enabled": "yes", "activationSeconds": "60", "recoverySeconds": True, "color": "red"})
        self.assertEqual(set(fields), {"enabled", "activationSeconds", "recoverySeconds", "color"})
        self.assertEqual(fields["color"], ["Unknown field."])
        self.assertIn("activationSeconds", self.errors({**VALID, "activationSeconds": 86_401}))
        self.assertIn("name", self.errors({**VALID, "name": "x" * 256}))
        self.assertIn("name", self.errors({**VALID, "name": "bad\x00name"}))
        self.assertIn("name", self.errors({**VALID, "name": "   "}))
        self.assertIn("reason", self.errors({**VALID, "reason": "offline"}))  # not an interface's
        self.assertIn("health", self.errors({**VALID, "health": "critical", "reason": None}))  # never critical
        self.assertIn("kind", self.errors({**VALID, "kind": "printer"}))
        self.assertIn("severity", self.errors({**VALID, "severity": "fatal"}))
        self.assertEqual(self.errors({**VALID, "customerId": "acme"})["customerId"], ["Expected the id of a customer."])
        missing = "00000000-0000-0000-0000-000000000000"
        self.assertEqual(self.errors({**VALID, "siteId": missing})["siteId"], ["No such site."])
        both = self.errors({**VALID, "customerId": str(self.acme.pk), "siteId": str(self.hq.pk)})
        self.assertIn("Choose a customer or a site, not both.", both["siteId"])
        self.assertIn("version", self.errors({**VALID, "version": 1}))
        self.assertFalse(AlertRule.objects.filter(name__icontains="interface").exists())
        self.assertFalse(ConfigurationEvent.objects.exists())

    def test_a_name_is_taken_whatever_its_case(self):
        self.assertEqual(self.errors({**VALID, "name": "SERVER OFFLINE"})["name"], ["An alert rule with this name already exists."])

    def test_the_body_must_be_a_small_json_object(self):
        response = self.client_.post(RULES, "name=x", content_type="application/x-www-form-urlencoded")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (415, "unsupported_media_type"))
        response = self.client_.post(RULES, "[1]", content_type="application/json")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "invalid_request"))
        response = post(self.client_, RULES, {**VALID, "description": "x" * 17000})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (413, "payload_too_large"))
        self.assertEqual(post(self.client_, RULES + "?dry=1", VALID).status_code, 400)


class ChangeTests(TestCase):
    def setUp(self):
        self.admin = rule_admin()
        self.client_ = signed_in_client(self.admin)
        self.rule = make_rule("Servers down", reason="offline")
        self.path = f"{RULES}{self.rule.pk}/"

    def change(self, body, status=200):
        response = patch(self.client_, self.path, body)
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def test_a_change_with_the_current_version_is_saved_and_recorded(self):
        body = self.change({"version": 1, "name": "Servers offline", "activationSeconds": 300})
        self.assertEqual((body["item"]["name"], body["item"]["activationSeconds"], body["item"]["version"]), ("Servers offline", 300, 2))
        self.assertEqual(body["effects"], {"openIncidents": 0, "closes": [], "closesAll": False})
        [event] = ConfigurationEvent.objects.all()
        self.assertEqual(event.action, "rule_changed")
        self.assertEqual(event.changes, {
            "activationSeconds": {"before": 60, "after": 300},
            "name": {"before": "Servers down", "after": "Servers offline"},
        })
        self.assertEqual(event.target_name, "Servers offline")

    def test_a_stale_version_is_a_conflict_and_changes_nothing(self):
        self.change({"version": 1, "description": "first"})
        body = self.change({"version": 1, "description": "second"}, status=409)
        self.assertEqual(body["error"]["code"], "version_conflict")
        self.rule.refresh_from_db()
        self.assertEqual((self.rule.description, self.rule.version), ("first", 2))
        self.assertEqual(ConfigurationEvent.objects.count(), 1)

    def test_a_change_made_in_the_admin_makes_the_consoles_version_stale(self):
        self.rule.description = "from the admin"
        self.rule.save()
        self.assertEqual(self.rule.version, 2)
        self.assertEqual(self.change({"version": 1, "enabled": False}, status=409)["error"]["code"], "version_conflict")

    def test_the_version_is_required(self):
        self.assertIn("version", self.change({"enabled": False}, status=400)["error"]["fields"])
        self.assertIn("version", self.change({"enabled": False, "version": "1"}, status=400)["error"]["fields"])

    def test_the_kind_never_changes(self):
        fields = self.change({"version": 1, "kind": "device"}, status=400)["error"]["fields"]
        self.assertEqual(fields["kind"], ["The kind of a rule cannot be changed. Disable it and add a new rule."])
        self.assertEqual(self.change({"version": 1, "kind": "server", "severity": "warning"})["item"]["kind"], "server")

    def test_nothing_to_change_changes_nothing(self):
        body = self.change({"version": 1, "name": "  Servers down "})
        self.assertEqual((body["item"]["version"], body["effects"]), (1, None))
        self.assertFalse(ConfigurationEvent.objects.exists())

    def test_what_a_change_ends_at_the_engines_next_cycle(self):
        open_incident(self.rule)
        body = self.change({"version": 1, "enabled": False})
        self.assertEqual(body["effects"], {"openIncidents": 1, "closes": ["rule_disabled"], "closesAll": True})
        self.assertEqual([event.action for event in ConfigurationEvent.objects.all()], ["rule_disabled"])
        body = self.change({"version": 2, "enabled": True, "severity": "warning"})
        self.assertEqual(body["effects"]["closes"], ["rule_changed"])
        self.assertEqual(
            sorted(ConfigurationEvent.objects.values_list("action", flat=True)),
            ["rule_changed", "rule_disabled", "rule_enabled"],
        )
        acme = Customer.objects.create(name="Acme")
        body = self.change({"version": 3, "customerId": str(acme.pk)})
        self.assertEqual(body["effects"], {"openIncidents": 1, "closes": ["out_of_scope"], "closesAll": False})

    def test_an_invalid_change_is_refused_whole(self):
        fields = self.change({"version": 1, "reason": "dead", "name": "Renamed"}, status=400)["error"]["fields"]
        self.assertIn("reason", fields)
        self.rule.refresh_from_db()
        self.assertEqual((self.rule.name, self.rule.version), ("Servers down", 1))


@PINNED
class EngineIntegrationTests(TestCase):
    """A change made through the console reaches the engine at its next cycle, as one made in the admin does."""

    def test_a_new_severity_ends_the_incidents_opened_under_the_old_one(self):
        AlertRule.objects.update(enabled=False)
        rule = AlertRule.objects.get(key="server-offline")
        rule.enabled = True
        rule.save()
        fleet = Fleet()
        fleet.server("web-1", site=fleet.hq, seen=0)
        evaluate(91)
        evaluate(150)
        incident = Incident.objects.get()
        response = patch(signed_in_client(rule_admin()), f"{RULES}{rule.pk}/", {"version": rule.version, "severity": "warning"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["effects"]["closes"], ["rule_changed"])
        evaluate(160)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.close_reason), ("closed", "rule_changed"))


class ConcurrentChangeTests(TransactionTestCase):
    def test_two_changes_from_the_same_version_one_wins_the_other_is_told(self):
        admin = rule_admin()
        rule = make_rule("Raced", reason="offline")
        barrier = threading.Barrier(2)
        statuses = []

        def change(description):
            try:
                client = signed_in_client(admin)
                barrier.wait()
                statuses.append(patch(client, f"{RULES}{rule.pk}/", {"version": 1, "description": description}).status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=change, args=(text,)) for text in ("one", "two")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(statuses), [200, 409])
        rule.refresh_from_db()
        self.assertEqual(rule.version, 2)
        self.assertEqual(ConfigurationEvent.objects.count(), 1)
