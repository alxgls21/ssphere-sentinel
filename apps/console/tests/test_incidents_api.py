"""Incidents in the console API: who sees which, what they say, and acknowledging them."""

import threading
import uuid
from datetime import timedelta

from django.contrib.auth.models import Permission
from django.db import connection
from django.test import Client, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.alerts.models import AlertEngineHeartbeat, AlertRule, Incident, IncidentEvent
from apps.console.tests.helpers import API, PINNED, ConsoleDataTestCase, make_server, make_user, signed_in_client
from apps.infrastructure.models import Server
from apps.inventory.models import Customer, Site

INCIDENTS = API + "incidents/"
ENGINE = API + "alerts/engine-status/"
ITEM_KEYS = {
    "id",
    "status",
    "severity",
    "condition",
    "entity",
    "rule",
    "siteId",
    "siteName",
    "customerName",
    "startedAt",
    "openedAt",
    "acknowledgedAt",
    "acknowledgedBy",
    "recoveredAt",
    "closedAt",
    "closeReason",
    "canAcknowledge",
}


def acknowledger(username: str, **grants):
    user = make_user(username, **grants)
    user.user_permissions.add(Permission.objects.get(content_type__app_label="alerts", codename="acknowledge_incident"))
    return type(user).objects.get(pk=user.pk)


class IncidentData(ConsoleDataTestCase):
    """Incidents on every kind of site, in every status, at known times before ``self.now``."""

    def setUp(self):
        super().setUp()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.dc = Site.objects.create(customer=self.acme, name="DC")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.offline = AlertRule.objects.get(key="server-offline")
        self.unreachable = AlertRule.objects.get(key="device-unreachable")
        self.failing = AlertRule.objects.get(key="target-failing")
        self.dead = AlertRule.objects.get(key="container-failed")
        self.ports = AlertRule.objects.create(
            name="Ports down", entity_kind="interface", health="warning", reason="down", severity="warning", activation_seconds=0
        )
        self.operator = acknowledger("operator", customers=[self.acme])
        self.web = make_server("hq-web", site=self.hq, now=self.now, seen_ago=600)
        self.i_web = self.incident(self.offline, "hq-web", site=self.hq, opened=600, ref=str(self.web.pk))
        self.i_db = self.incident(self.offline, "dc-db", site=self.dc, opened=900)
        self.i_db.acknowledge(self.operator, at=self.ago(300))
        self.i_fw = self.incident(self.unreachable, "plant-fw", site=self.plant, opened=1200)
        self.i_gw = self.incident(self.failing, "hq-gw", site=self.hq, opened=3600)
        self.i_gw.recover(recovered_at=self.ago(1800), at=self.ago(1700), health="healthy", reason="ok")
        self.i_api = self.incident(self.dead, "api on hq-web", site=self.hq, opened=7200)
        self.i_api.close("entity_removed", at=self.ago(7000))
        self.i_lab = self.incident(self.offline, "lab-1", site=None, opened=100)
        self.i_port = self.incident(self.ports, "Gi0/7 on hq-sw", site=self.hq, opened=50)

    def ago(self, seconds: float):
        return self.now - timedelta(seconds=seconds)

    def incident(self, rule, label, *, site, opened, ref=None) -> Incident:
        kind = rule.entity_kind
        if ref is None:
            ref = str(uuid.uuid4())
            if kind == "container":
                ref += ":3f4e5d6c7b8a"
            elif kind == "interface":
                ref += ":7"
        return Incident.begin(
            rule=rule,
            entity_kind=kind,
            entity_ref=ref,
            entity_label=label,
            site_id=site.pk if site else None,
            started_at=self.ago(opened + 60),
            opened_at=self.ago(opened),
            health=rule.health,
            reason=rule.reason,
        )

    def labels(self, response) -> list[str]:
        self.assertEqual(response.status_code, 200, response.content[:300])
        return [item["entity"]["label"] for item in response.json()["items"]]

    def list(self, user, **params):
        return self.get(user, "incidents/", **params)


class AccessTests(IncidentData):
    def test_a_console_session_is_required(self):
        self.assertEqual(Client().get(INCIDENTS).status_code, 401)
        self.assertEqual(self.list(make_user("no-console", console=False, all_customers=True)).status_code, 403)
        # A session from anywhere else (the admin's) is not a console session.
        admin = Client()
        admin.force_login(make_user("admin-only", all_customers=True))
        self.assertEqual(admin.get(INCIDENTS).status_code, 401)

    def test_each_user_sees_the_incidents_of_their_sites_only(self):
        newest_first = ["Gi0/7 on hq-sw", "lab-1", "hq-web", "dc-db", "plant-fw", "hq-gw", "api on hq-web"]
        self.assertEqual(self.labels(self.list(make_user("all", all_customers=True))), newest_first)
        self.assertEqual(self.labels(self.list(make_user("acme", customers=[self.acme]))), ["Gi0/7 on hq-sw", "hq-web", "dc-db", "hq-gw", "api on hq-web"])
        self.assertEqual(self.labels(self.list(make_user("hq", sites=[self.hq]))), ["Gi0/7 on hq-sw", "hq-web", "hq-gw", "api on hq-web"])
        self.assertEqual(self.labels(self.list(make_user("globex", customers=[self.globex]))), ["plant-fw"])
        self.assertEqual(self.labels(self.list(make_user("nobody"))), [])

    def test_hidden_incidents_are_not_found_wherever_they_are_asked_for(self):
        hq_user = make_user("hq", sites=[self.hq])
        client = signed_in_client(hq_user)
        for incident in (self.i_db, self.i_fw, self.i_lab):
            with self.subTest(incident=incident.entity_label):
                response = client.get(f"{INCIDENTS}{incident.pk}/")
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"error": {"code": "not_found", "message": "Not found."}})
        self.assertEqual(client.get(f"{INCIDENTS}{uuid.uuid4()}/").status_code, 404)
        self.assertEqual(client.get(f"{INCIDENTS}not-an-id/").status_code, 404)

    def test_a_scope_narrows_within_what_the_user_may_see(self):
        everyone = make_user("all", all_customers=True)
        self.assertEqual(self.labels(self.list(everyone, customer=self.acme.pk)), ["Gi0/7 on hq-sw", "hq-web", "dc-db", "hq-gw", "api on hq-web"])
        self.assertEqual(self.labels(self.list(everyone, site=self.dc.pk)), ["dc-db"])
        hq_user = make_user("hq", sites=[self.hq])
        self.assertEqual(self.list(hq_user, site=self.dc.pk).status_code, 404)
        self.assertEqual(self.list(hq_user, customer=self.globex.pk).status_code, 404)
        self.assertEqual(self.list(everyone, site="not-a-uuid").status_code, 400)


class ListTests(IncidentData):
    def setUp(self):
        super().setUp()
        self.user = make_user("all", all_customers=True)

    def test_filters_by_status_severity_kind_and_search(self):
        cases = (
            ({"status": "open"}, ["Gi0/7 on hq-sw", "lab-1", "hq-web", "dc-db", "plant-fw"]),
            ({"status": "active"}, ["Gi0/7 on hq-sw", "lab-1", "hq-web", "plant-fw"]),
            ({"status": "acknowledged"}, ["dc-db"]),
            ({"status": "ended"}, ["hq-gw", "api on hq-web"]),
            ({"status": "recovered"}, ["hq-gw"]),
            ({"status": "closed"}, ["api on hq-web"]),
            ({"severity": "warning"}, ["Gi0/7 on hq-sw"]),
            ({"severity": "critical", "status": "open"}, ["lab-1", "hq-web", "dc-db", "plant-fw"]),
            ({"kind": "device"}, ["plant-fw"]),
            ({"kind": "container"}, ["api on hq-web"]),
            ({"q": "hq"}, ["Gi0/7 on hq-sw", "hq-web", "hq-gw", "api on hq-web"]),  # in the name, or the site's
            ({"q": "globex"}, ["plant-fw"]),  # the customer's name
            ({"q": "failing"}, ["hq-gw"]),  # the rule's name
            ({"q": str(self.web.pk)[:13]}, ["hq-web"]),  # the object's reference
            ({"q": "hq web"}, ["hq-web", "api on hq-web"]),  # every word
        )
        for params, expected in cases:
            with self.subTest(**params):
                self.assertEqual(self.labels(self.list(self.user, **params)), expected)

    def test_counts_describe_the_search_and_filters_but_not_the_status(self):
        body = self.list(self.user, status="active").json()
        self.assertEqual(body["counts"], {"active": 4, "acknowledged": 1, "recovered": 1, "closed": 1})
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (4, 7))
        body = self.list(self.user, q="hq", status="ended").json()
        self.assertEqual(body["counts"], {"active": 2, "acknowledged": 0, "recovered": 1, "closed": 1})
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (2, 7))
        body = self.list(self.user, site=self.hq.pk, kind="server").json()
        self.assertEqual((body["counts"]["active"], body["scopeTotal"]), (1, 4))

    def test_pages(self):
        first = self.list(self.user, pageSize=3).json()
        self.assertEqual(first["page"], {"number": 1, "size": 3, "total": 7, "pages": 3})
        self.assertEqual([item["entity"]["label"] for item in first["items"]], ["Gi0/7 on hq-sw", "lab-1", "hq-web"])
        third = self.list(self.user, pageSize=3, page=3).json()
        self.assertEqual([item["entity"]["label"] for item in third["items"]], ["api on hq-web"])
        beyond = self.list(self.user, pageSize=3, page=9).json()
        self.assertEqual((beyond["items"], beyond["page"]["total"]), ([], 7))

    def test_sorting(self):
        cases = (
            ({"sort": "opened", "dir": "asc"}, ["api on hq-web", "hq-gw", "plant-fw", "dc-db", "hq-web", "lab-1", "Gi0/7 on hq-sw"]),
            ({"sort": "started"}, ["Gi0/7 on hq-sw", "lab-1", "hq-web", "dc-db", "plant-fw", "hq-gw", "api on hq-web"]),
            ({"sort": "severity"}, ["lab-1", "hq-web", "dc-db", "plant-fw", "hq-gw", "api on hq-web", "Gi0/7 on hq-sw"]),
            ({"sort": "severity", "dir": "asc"}, ["Gi0/7 on hq-sw", "lab-1", "hq-web", "dc-db", "plant-fw", "hq-gw", "api on hq-web"]),
            ({"sort": "status"}, ["Gi0/7 on hq-sw", "lab-1", "hq-web", "plant-fw", "dc-db", "hq-gw", "api on hq-web"]),
            ({"sort": "name"}, ["api on hq-web", "dc-db", "Gi0/7 on hq-sw", "hq-gw", "hq-web", "lab-1", "plant-fw"]),
            ({"sort": "name", "dir": "desc"}, ["plant-fw", "lab-1", "hq-web", "hq-gw", "Gi0/7 on hq-sw", "dc-db", "api on hq-web"]),
        )
        for params, expected in cases:
            with self.subTest(**params):
                self.assertEqual(self.labels(self.list(self.user, **params)), expected)

    def test_invalid_parameters_are_refused_and_not_echoed(self):
        for params in (
            {"stauts": "open"},
            {"status": "resolved"},
            {"severity": "info"},
            {"kind": "router"},
            {"sort": "rule"},
            {"dir": "up"},
            {"page": "0"},
            {"pageSize": "201"},
            {"q": "x" * 201},
            {"q": "a\x00b"},
            {"customer": "<script>"},
        ):
            with self.subTest(**params):
                response = self.list(self.user, **params)
                self.assertEqual(response.status_code, 400)
                self.assertNotIn("<script>", response.content.decode())
        client = signed_in_client(self.user)
        self.assertEqual(client.get(INCIDENTS + "?status=open&status=closed").status_code, 400)

    def test_an_item_says_what_happened_when_and_to_what(self):
        items = {item["entity"]["label"]: item for item in self.list(make_user("all-2", all_customers=True)).json()["items"]}
        db = items["dc-db"]
        self.assertEqual(set(db), ITEM_KEYS)
        self.assertEqual(
            {key: db[key] for key in ("status", "severity", "condition", "rule", "siteId", "siteName", "customerName")},
            {
                "status": "acknowledged",
                "severity": "critical",
                "condition": {"health": "critical", "reason": "offline"},
                "rule": {"id": str(self.offline.pk), "name": "Server offline"},
                "siteId": str(self.dc.pk),
                "siteName": "DC",
                "customerName": "Acme",
            },
        )
        self.assertEqual(db["entity"], {"kind": "server", "ref": self.i_db.entity_ref, "label": "dc-db"})
        self.assertEqual((db["acknowledgedBy"], db["canAcknowledge"]), ("operator", False))
        self.assertTrue(db["acknowledgedAt"].endswith("Z"))
        gw = items["hq-gw"]
        self.assertEqual((gw["status"], gw["closeReason"], gw["acknowledgedAt"]), ("recovered", None, None))
        self.assertIsNotNone(gw["recoveredAt"])
        api = items["api on hq-web"]
        self.assertEqual((api["status"], api["closeReason"], api["recoveredAt"]), ("closed", "entity_removed", None))
        lab = items["lab-1"]
        self.assertEqual(set(lab), ITEM_KEYS - {"siteName", "customerName"})  # an object on no site
        self.assertIsNone(lab["siteId"])
        port = items["Gi0/7 on hq-sw"]
        self.assertEqual((port["severity"], port["condition"]), ("warning", {"health": "warning", "reason": "down"}))

    def test_only_a_user_who_may_acknowledge_is_offered_to(self):
        offered = {item["entity"]["label"]: item["canAcknowledge"] for item in self.list(self.operator).json()["items"]}
        self.assertEqual(offered, {"Gi0/7 on hq-sw": True, "hq-web": True, "dc-db": False, "hq-gw": False, "api on hq-web": False})
        viewer = make_user("viewer", customers=[self.acme])
        self.assertFalse(any(item["canAcknowledge"] for item in self.list(viewer).json()["items"]))

    def test_the_number_of_queries_does_not_grow_with_the_incidents(self):
        with CaptureQueriesContext(connection) as small:
            self.list(self.user, status="open")
        for index in range(30):
            self.incident(self.offline, f"more-{index}", site=self.hq, opened=10 + index)
        with CaptureQueriesContext(connection) as large:
            self.list(self.user, status="open")
        self.assertEqual(len(small), len(large))


class DetailTests(IncidentData):
    def test_the_detail_has_the_rule_the_object_and_the_timeline(self):
        body = signed_in_client(self.operator).get(f"{INCIDENTS}{self.i_db.pk}/").json()
        self.assertEqual(set(body), {"generatedAt", "item", "rule", "entityVisible", "timeline"})
        self.assertEqual(body["item"]["id"], str(self.i_db.pk))
        self.assertEqual(
            body["rule"],
            {"id": str(self.offline.pk), "name": "Server offline", "description": self.offline.description, "enabled": True},
        )
        self.assertEqual(
            [(event["kind"], event["health"], event["reason"], event["actor"]) for event in body["timeline"]],
            [("opened", "critical", "offline", None), ("acknowledged", None, None, "operator")],
        )
        self.assertEqual({key for event in body["timeline"] for key in event}, {"at", "kind", "health", "reason", "actor"})

    def test_a_recovery_is_in_the_timeline_in_order(self):
        IncidentEvent.objects.create(incident=self.i_gw, kind="recovery_started", at=self.ago(1800), health="healthy", reason="ok")
        body = self.get(make_user("all", all_customers=True), f"incidents/{self.i_gw.pk}/").json()
        self.assertEqual([event["kind"] for event in body["timeline"]], ["opened", "recovery_started", "recovered"])
        self.assertEqual(body["item"]["recoveredAt"], body["timeline"][1]["at"])

    def test_the_object_is_linked_only_while_this_user_may_see_it(self):
        acme_user = make_user("acme", customers=[self.acme])
        path = f"incidents/{self.i_web.pk}/"
        self.assertTrue(self.get(acme_user, path).json()["entityVisible"])
        # Moved to another customer: the incident stays Acme's, the object is no longer theirs to open.
        Server.objects.filter(pk=self.web.pk).update(site=self.plant, name="globex-web")
        body = self.get(acme_user, path).json()
        self.assertFalse(body["entityVisible"])
        self.assertEqual(body["item"]["entity"]["label"], "hq-web")  # what it was called on their site
        self.assertNotIn("globex-web", str(body))
        self.assertEqual(self.get(make_user("globex", customers=[self.globex]), path).status_code, 404)
        Server.objects.filter(pk=self.web.pk).delete()
        self.assertFalse(self.get(make_user("all", all_customers=True), path).json()["entityVisible"])

    def test_no_parameters_are_taken(self):
        self.assertEqual(self.get(self.operator, f"incidents/{self.i_web.pk}/", page=1).status_code, 400)


class AcknowledgeTests(IncidentData):
    def ack(self, user, incident, *, client=None):
        client = client or signed_in_client(user)
        return client.post(f"{INCIDENTS}{incident.pk}/acknowledge/")

    def test_it_needs_the_incident_visible_and_the_permission(self):
        viewer = make_user("viewer", customers=[self.acme])
        response = self.ack(viewer, self.i_web)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "forbidden"))
        globex_operator = acknowledger("globex-operator", customers=[self.globex])
        self.assertEqual(self.ack(globex_operator, self.i_web).status_code, 404)  # hidden: as if it did not exist
        self.assertEqual(self.ack(self.operator, self.i_lab).status_code, 404)
        self.assertEqual(self.ack(self.operator, self.i_fw).status_code, 404)
        self.assertEqual(Incident.objects.get(pk=self.i_web.pk).status, "active")

    def test_the_permission_alone_opens_no_console(self):
        ack_only = acknowledger("ack-only", console=False, all_customers=True)
        response = self.ack(ack_only, self.i_web)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "forbidden"))
        self.assertEqual(Client().post(f"{INCIDENTS}{self.i_web.pk}/acknowledge/").status_code, 401)
        self.assertEqual(Incident.objects.get(pk=self.i_web.pk).status, "active")

    def test_it_records_who_and_when_and_the_incident_stays_open(self):
        response = self.ack(self.operator, self.i_web)
        self.assertEqual(response.status_code, 200)
        item = response.json()["item"]
        self.assertEqual((item["status"], item["acknowledgedBy"], item["canAcknowledge"]), ("acknowledged", "operator", False))
        incident = Incident.objects.get(pk=self.i_web.pk)
        self.assertEqual((incident.status, incident.acknowledged_at, incident.acknowledged_by), ("acknowledged", self.now, self.operator))
        self.assertIsNone(incident.closed_at)
        self.assertEqual(incident.events.filter(kind="acknowledged").get().actor_name, "operator")

    def test_it_is_idempotent_and_the_first_acknowledgement_stays(self):
        self.assertEqual(self.ack(self.operator, self.i_web).status_code, 200)
        second = acknowledger("second", customers=[self.acme])
        response = self.ack(second, self.i_web)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["item"]["acknowledgedBy"], "operator")
        self.assertEqual(self.ack(self.operator, self.i_web).status_code, 200)
        self.assertEqual(IncidentEvent.objects.filter(incident=self.i_web, kind="acknowledged").count(), 1)

    def test_an_ended_incident_cannot_be_acknowledged(self):
        for incident in (self.i_gw, self.i_api):
            with self.subTest(incident=incident.entity_label):
                response = self.ack(self.operator, incident)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "incident_ended"))
                self.assertFalse(IncidentEvent.objects.filter(incident=incident, kind="acknowledged").exists())

    def test_it_is_a_post_with_csrf_and_without_parameters(self):
        client = signed_in_client(self.operator, enforce_csrf=True)
        path = f"{INCIDENTS}{self.i_web.pk}/acknowledge/"
        response = client.post(path)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        self.assertEqual(Incident.objects.get(pk=self.i_web.pk).status, "active")
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(client.get(path).status_code, 405)
        self.assertEqual(client.get(path)["Allow"], "POST")
        self.assertEqual(client.post(path + "?force=1", HTTP_X_CSRFTOKEN=token).status_code, 400)
        self.assertEqual(client.post(path, HTTP_X_CSRFTOKEN=token).status_code, 200)
        self.assertEqual(Incident.objects.get(pk=self.i_web.pk).status, "acknowledged")

    def test_incidents_cannot_be_resolved_by_hand(self):
        client = signed_in_client(self.operator)
        for path in (f"{INCIDENTS}{self.i_web.pk}/resolve/", f"{INCIDENTS}{self.i_web.pk}/close/"):
            self.assertEqual(client.post(path).status_code, 404)
        self.assertEqual(client.post(f"{INCIDENTS}{self.i_web.pk}/").status_code, 405)


class EngineStatusTests(ConsoleDataTestCase):
    KEYS = {
        "generatedAt",
        "state",
        "stale",
        "staleAfterSeconds",
        "intervalSeconds",
        "startedAt",
        "lastSuccessAt",
        "lastAttemptAt",
        "lastCycleMs",
        "lastError",
        "monitoringSince",
    }

    def setUp(self):
        super().setUp()
        self.user = make_user("viewer")

    def ago(self, seconds):
        return self.now - timedelta(seconds=seconds) if seconds is not None else None

    def status(self, **beat):
        if beat:
            AlertEngineHeartbeat.objects.update_or_create(pk=1, defaults={"started_at": self.ago(3600), "interval_seconds": 30, **beat})
        response = self.get(self.user, "alerts/engine-status/")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), self.KEYS)
        return body

    def test_never_started(self):
        body = self.status()
        self.assertEqual((body["state"], body["stale"], body["lastSuccessAt"], body["lastAttemptAt"], body["lastError"]), ("never_started", True, None, None, None))

    def test_running_is_a_recent_successful_cycle_not_a_row(self):
        body = self.status(beat_at=self.ago(10), last_cycle_ms=40, monitoring_since=self.ago(3000))
        self.assertEqual((body["state"], body["stale"], body["staleAfterSeconds"], body["lastCycleMs"]), ("running", False, 90, 40))
        self.assertEqual(body["lastSuccessAt"], body["lastAttemptAt"])
        # The row is still there, its cycle is not recent: stopped or stuck.
        body = self.status(beat_at=self.ago(91))
        self.assertEqual((body["state"], body["stale"]), ("stale", True))

    def test_failing_cycles(self):
        body = self.status(beat_at=self.ago(600), last_error_at=self.ago(5), last_error_category="database", last_error_type="OperationalError")
        self.assertEqual((body["state"], body["stale"]), ("failed", False))
        self.assertEqual(body["lastError"], {"at": body["lastAttemptAt"], "category": "database"})
        # It recovered: running again, and the last failure stays on record.
        body = self.status(beat_at=self.ago(1))
        self.assertEqual((body["state"], body["lastError"]["category"]), ("running", "database"))
        # It failed long ago and has not tried since.
        body = self.status(beat_at=None, last_error_at=self.ago(500))
        self.assertEqual(body["state"], "stale")
        # It never once succeeded, and keeps failing.
        body = self.status(beat_at=None, last_error_at=self.ago(2), last_error_category="")
        self.assertEqual((body["state"], body["lastError"]["category"]), ("failed", "internal"))

    def test_a_slower_engine_is_late_later(self):
        body = self.status(beat_at=self.ago(300), interval_seconds=120)
        self.assertEqual((body["state"], body["staleAfterSeconds"], body["intervalSeconds"]), ("running", 360, 120))

    def test_no_error_detail_leaves_the_server(self):
        body = self.status(beat_at=self.ago(600), last_error_at=self.ago(5), last_error_category="internal", last_error_type="KeyError")
        self.assertNotIn("KeyError", str(body))

    def test_it_needs_the_console(self):
        self.assertEqual(Client().get(ENGINE).status_code, 401)
        self.assertEqual(self.get(self.user, "alerts/engine-status/", verbose=1).status_code, 400)


@PINNED
class ConcurrentAcknowledgeTests(TransactionTestCase):
    def test_two_acknowledgements_at_once_record_one(self):
        customer = Customer.objects.create(name="Acme")
        site = Site.objects.create(customer=customer, name="HQ")
        rule = AlertRule.objects.create(name="Offline", entity_kind="server", health="critical", reason="offline", severity="critical")
        incident = Incident.begin(
            rule=rule,
            entity_kind="server",
            entity_ref=str(uuid.uuid4()),
            entity_label="web-1",
            site_id=site.pk,
            started_at=timezone.now() - timedelta(minutes=5),
            opened_at=timezone.now() - timedelta(minutes=4),
        )
        clients = [signed_in_client(acknowledger(name, customers=[customer])) for name in ("first", "second")]
        barrier = threading.Barrier(2)
        statuses = []

        def acknowledge(client):
            try:
                barrier.wait()
                statuses.append(client.post(f"{INCIDENTS}{incident.pk}/acknowledge/").status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=acknowledge, args=(client,)) for client in clients]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(statuses), [200, 200])
        self.assertEqual(IncidentEvent.objects.filter(incident=incident, kind="acknowledged").count(), 1)
        stored = Incident.objects.get(pk=incident.pk)
        self.assertEqual(stored.status, "acknowledged")
        self.assertEqual(
            stored.acknowledged_by.username, IncidentEvent.objects.get(incident=incident, kind="acknowledged").actor_name
        )
