"""Alert rules, incidents and evaluation states: what the models and the database allow."""

from contextlib import contextmanager

from django.contrib.auth.models import Group, Permission
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import TestCase
from django.urls import reverse

from apps.alerts.conditions import HEALTH, REASONS, EntityKind, reasons_for
from apps.alerts.models import (
    AlertEngineHeartbeat,
    AlertEvaluationState,
    AlertRule,
    ImmutableIncident,
    Incident,
    IncidentEvent,
)
from apps.alerts.tests.helpers import at, make_rule, open_incident, ref
from apps.console import health
from apps.console.access import Visibility
from apps.console.groups import VIEWERS, VIEWERS_ALL
from apps.console.tests.helpers import make_user
from apps.inventory.models import Customer, Site
from django.apps import apps as django_apps


@contextmanager
def refused(test: TestCase):
    """The database refuses the statement inside (in a savepoint, so the test goes on)."""
    with test.assertRaises(IntegrityError), transaction.atomic():
        yield


class VocabularyTests(TestCase):
    def test_the_reasons_are_the_consoles_own(self):
        self.assertEqual(set(REASONS[EntityKind.SERVER]), set(health.SERVER_REASONS))
        self.assertEqual(set(REASONS[EntityKind.CONTAINER]), set(health.CONTAINER_REASONS))
        self.assertEqual(set(REASONS[EntityKind.TARGET]), set(health.TARGET_REASONS))
        self.assertEqual(set(REASONS[EntityKind.DEVICE]), set(health.DEVICE_REASONS))
        self.assertEqual(set(REASONS[EntityKind.INTERFACE]), set(health.INTERFACE_REASONS))

    def test_every_reason_comes_with_the_consoles_statuses(self):
        self.assertEqual(set(HEALTH), set(health.HEALTH_NAMES.values()))
        for kind, reasons in REASONS.items():
            for reason, statuses in reasons.items():
                with self.subTest(kind=kind, reason=reason):
                    self.assertTrue(statuses and statuses <= set(HEALTH))

    def test_each_kinds_critical_reasons_are_the_consoles(self):
        # The console's own rules (apps.console.health): what is critical, and why.
        expected = {
            "server": ("offline", "resources"),
            "container": ("dead", "unhealthy"),
            "target": ("failing",),
            "device": ("unreachable",),
            "interface": (),
        }
        for kind, reasons in expected.items():
            self.assertEqual(reasons_for(kind, "critical"), reasons, kind)


class AlertRuleTests(TestCase):
    def test_a_rule_names_a_kind_a_condition_and_optionally_a_reason(self):
        rule = make_rule("Device data stale", entity_kind="device", health="unknown", reason="stale", severity="warning")
        rule.refresh_from_db()
        self.assertEqual((rule.condition, rule.health, rule.reason, rule.enabled), ("health", "unknown", "stale", True))
        self.assertEqual((rule.activation_seconds, rule.recovery_seconds), (60, 120))
        self.assertIsNone(rule.key)

    def test_a_reason_must_be_one_the_console_gives_for_the_kind(self):
        with self.assertRaises(ValidationError) as raised:
            make_rule(entity_kind="server", reason="unreachable")
        self.assertIn("reason", raised.exception.message_dict)

    def test_a_reason_must_be_able_to_fire_the_condition(self):
        with self.assertRaises(ValidationError) as raised:
            make_rule(entity_kind="target", health="critical", reason="latency")
        self.assertIn("reason", raised.exception.message_dict)
        make_rule("Slow targets", entity_kind="target", health="warning", reason="latency", severity="warning")

    def test_a_condition_the_kind_never_has_is_refused(self):
        with self.assertRaises(ValidationError) as raised:
            make_rule(entity_kind="interface", health="critical")
        self.assertIn("health", raised.exception.message_dict)

    def test_the_scope_is_everything_a_customer_or_a_site_never_both(self):
        customer = Customer.objects.create(name="Acme")
        site = Site.objects.create(customer=customer, name="HQ")
        make_rule("Acme only", customer=customer)
        make_rule("HQ only", site=site)
        with self.assertRaises(ValidationError) as raised:
            make_rule("Both", customer=customer, site=site)
        self.assertIn("site", raised.exception.message_dict)

    def test_durations_are_whole_seconds_up_to_a_day(self):
        make_rule("Immediate", activation_seconds=0, recovery_seconds=86_400)
        for fields in ({"activation_seconds": 86_401}, {"recovery_seconds": -1}):
            with self.subTest(**fields), self.assertRaises(ValidationError):
                make_rule("Too long", **fields)

    def test_names_are_unique_whatever_the_case(self):
        make_rule("Core switches")
        with self.assertRaises(ValidationError):
            make_rule(" core SWITCHES ")

    def test_the_kind_of_a_rule_cannot_change(self):
        rule = make_rule()
        rule.entity_kind = "device"
        rule.reason = ""
        with self.assertRaises(ValidationError) as raised:
            rule.save()
        self.assertIn("entity_kind", raised.exception.message_dict)

    def test_the_database_refuses_what_validation_would(self):
        customer = Customer.objects.create(name="Acme")
        site = Site.objects.create(customer=customer, name="HQ")
        rule = make_rule(entity_kind="target", health="warning", reason="latency", severity="warning")
        rules = AlertRule.objects.filter(pk=rule.pk)
        for change in (
            {"reason": "unreachable"},  # another kind's
            {"health": "critical"},  # latency is never critical
            {"health": "unknown"},
            {"entity_kind": "interface", "health": "critical", "reason": ""},  # never critical
            {"entity_kind": "router"},
            {"severity": "info"},
            {"condition": "metric"},
            {"activation_seconds": 86_401},
            {"customer": customer, "site": site},
        ):
            with self.subTest(change=change), refused(self):
                rules.update(**change)

    def test_a_rule_with_history_is_disabled_not_deleted(self):
        rule = make_rule()
        open_incident(rule)
        with self.assertRaises(ProtectedError):
            rule.delete()
        rule.enabled = False
        rule.save()
        self.assertFalse(AlertRule.objects.get(pk=rule.pk).enabled)

    def test_a_rule_without_history_is_deleted_with_its_evaluation_states(self):
        rule = make_rule()
        AlertEvaluationState.objects.create(
            rule=rule, entity_kind="server", entity_ref=ref(), phase="pending", condition_health="critical", condition_since=at(0), last_health="critical"
        )
        rule.delete()
        self.assertFalse(AlertEvaluationState.objects.exists())

    def test_a_customer_or_site_in_a_rules_scope_is_not_deleted_with_it(self):
        customer = Customer.objects.create(name="Acme")
        site = Site.objects.create(customer=customer, name="HQ")
        make_rule("HQ only", site=site)
        with self.assertRaises(ProtectedError):
            site.delete()


class IncidentLifecycleTests(TestCase):
    def setUp(self):
        self.rule = make_rule(reason="offline")
        self.user = make_user("operator")

    def test_opening_records_when_the_condition_began_and_the_rules_condition(self):
        incident = open_incident(self.rule, started=0, opened=60)
        self.assertEqual((incident.status, incident.severity), ("active", "critical"))
        self.assertEqual((incident.condition_health, incident.condition_reason), ("critical", "offline"))
        self.assertTrue(incident.matches_rule(self.rule))
        for change in ({"severity": "warning"}, {"reason": "resources"}, {"health": "warning"}):
            changed = AlertRule.objects.get(pk=self.rule.pk)
            for name, value in change.items():
                setattr(changed, name, value)
            with self.subTest(change=change):
                self.assertFalse(incident.matches_rule(changed))
        renamed = AlertRule.objects.get(pk=self.rule.pk)
        renamed.name, renamed.activation_seconds = "Renamed", 300
        self.assertTrue(incident.matches_rule(renamed))
        self.assertEqual((incident.started_at, incident.opened_at), (at(0), at(60)))
        self.assertTrue(incident.is_open)
        event = incident.events.get()
        self.assertEqual((event.kind, event.at, event.health, event.reason), ("opened", at(60), "critical", "offline"))

    def test_one_open_incident_per_rule_and_object(self):
        server = ref()
        open_incident(self.rule, server)
        with refused(self):
            open_incident(self.rule, server)
        open_incident(self.rule, ref())  # another object
        open_incident(make_rule("Second rule"), server)  # another rule
        self.assertEqual(Incident.objects.open().count(), 3)

    def test_acknowledging_does_not_resolve(self):
        server = ref()
        incident = open_incident(self.rule, server)
        self.assertTrue(incident.acknowledge(self.user, at=at(90)))
        self.assertEqual((incident.status, incident.acknowledged_at, incident.acknowledged_by), ("acknowledged", at(90), self.user))
        self.assertTrue(incident.is_open)
        self.assertIsNone(incident.closed_at)
        self.assertIn(incident, Incident.objects.open())
        with refused(self):  # still the open one
            open_incident(self.rule, server)
        event = incident.events.get(kind="acknowledged")
        self.assertEqual((event.actor, event.actor_name), (self.user, "operator"))

    def test_an_incident_is_acknowledged_once(self):
        incident = open_incident(self.rule)
        self.assertTrue(incident.acknowledge(self.user, at=at(90)))
        self.assertFalse(incident.acknowledge(make_user("other"), at=at(95)))
        incident.refresh_from_db()
        self.assertEqual(incident.acknowledged_by, self.user)
        self.assertEqual(incident.events.filter(kind="acknowledged").count(), 1)

    def test_recovery_ends_it_with_when_it_began_and_when_it_was_confirmed(self):
        incident = open_incident(self.rule)
        self.assertTrue(incident.recover(recovered_at=at(300), at=at(420), health="healthy", reason="ok"))
        self.assertEqual((incident.status, incident.recovered_at, incident.closed_at), ("recovered", at(300), at(420)))
        self.assertFalse(incident.is_open)
        self.assertEqual(incident.close_reason, "")
        self.assertEqual(list(incident.events.values_list("kind", flat=True)), ["opened", "recovered"])

    def test_an_acknowledged_incident_recovers_too(self):
        incident = open_incident(self.rule)
        incident.acknowledge(self.user, at=at(90))
        self.assertTrue(incident.recover(recovered_at=at(300), at=at(420)))
        self.assertEqual((incident.status, incident.acknowledged_by), ("recovered", self.user))

    def test_a_recovered_incident_never_changes_again(self):
        incident = open_incident(self.rule)
        incident.recover(recovered_at=at(300), at=at(420))
        self.assertFalse(incident.acknowledge(self.user, at=at(500)))
        self.assertFalse(incident.recover(recovered_at=at(600), at=at(700)))
        self.assertFalse(incident.close("rule_disabled", at=at(700)))
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.recovered_at, incident.closed_at), ("recovered", at(300), at(420)))
        self.assertEqual(incident.events.count(), 2)
        for change in ({"status": "active"}, {"closed_at": at(900)}, {"recovered_at": at(400)}, {"close_reason": "entity_moved"}):
            with self.subTest(change=change), self.assertRaises(ImmutableIncident):
                stored = Incident.objects.get(pk=incident.pk)
                for name, value in change.items():
                    setattr(stored, name, value)
                stored.save()
        # Even a bulk update cannot reopen it: an open incident has not ended.
        with refused(self):
            Incident.objects.filter(pk=incident.pk).update(status="active")

    def test_a_later_failure_opens_a_new_incident(self):
        server = ref()
        first = open_incident(self.rule, server)
        first.recover(recovered_at=at(300), at=at(420))
        second = open_incident(self.rule, server, started=600, opened=660)
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(Incident.objects.get(pk=first.pk).status, "recovered")
        self.assertEqual(list(Incident.objects.open()), [second])

    def test_an_incident_can_end_without_a_recovery_and_says_why(self):
        incident = open_incident(self.rule)
        with self.assertRaises(ValueError):
            incident.close("resolved by hand", at=at(120))
        self.assertIn("rule_changed", Incident.CloseReason.values)
        self.assertTrue(incident.close("entity_moved", at=at(120)))
        self.assertEqual((incident.status, incident.close_reason, incident.closed_at), ("closed", "entity_moved", at(120)))
        self.assertIsNone(incident.recovered_at)
        self.assertFalse(incident.recover(recovered_at=at(130), at=at(200)))

    def test_what_an_incident_is_about_never_changes(self):
        customer = Customer.objects.create(name="Acme")
        hq, dc = Site.objects.create(customer=customer, name="HQ"), Site.objects.create(customer=customer, name="DC")
        incident = open_incident(self.rule, site=hq)
        for name, value in (
            ("site", dc),
            ("site", None),
            ("entity_label", "renamed"),
            ("entity_ref", ref()),
            ("severity", "warning"),
            ("condition_reason", "resources"),
        ):
            with self.subTest(field=name), self.assertRaises(ImmutableIncident):
                stored = Incident.objects.get(pk=incident.pk)
                setattr(stored, name, value)
                stored.save()

    def test_the_database_keeps_the_lifecycle_consistent(self):
        incident = open_incident(self.rule)
        rows = Incident.objects.filter(pk=incident.pk)
        for change in (
            {"status": "recovered", "closed_at": at(400)},  # no recovered_at
            {"status": "closed", "closed_at": at(400)},  # no reason
            {"closed_at": at(400)},  # open, yet ended
            {"acknowledged_at": at(90)},  # active, yet acknowledged
            {"status": "acknowledged"},  # acknowledged, but when?
            {"acknowledged_by": self.user},
            {"recovered_at": at(300)},  # open, yet recovered
            {"opened_at": at(-1)},  # before the condition began
            {"status": "recovered", "recovered_at": at(500), "closed_at": at(400)},  # confirmed before it began
            {"status": "pending"},
            {"severity": "info"},
        ):
            with self.subTest(change=change), refused(self):
                rows.update(**change)

    def test_objects_are_referred_to_in_their_kinds_form(self):
        server = ref("server")
        for kind, bad in (
            ("server", "srv-1"),
            ("server", server.upper()),
            ("container", server),  # no Docker id
            ("container", f"{server}:a:b"),
            ("interface", f"{server}:0"),
            ("interface", f"{server}:x"),
            ("router", server),
        ):
            with self.subTest(kind=kind, ref=bad), refused(self):
                Incident.objects.create(
                    rule=self.rule, entity_kind=kind, entity_ref=bad, entity_label="x", condition_health="critical", severity="critical", started_at=at(0), opened_at=at(0)
                )
        for kind in EntityKind.values:
            Incident.objects.create(
                rule=self.rule, entity_kind=kind, entity_ref=ref(kind), entity_label="x", condition_health="critical", severity="critical", started_at=at(0), opened_at=at(0)
            )

    def test_each_step_happens_once_and_only_an_acknowledgement_has_an_actor(self):
        incident = open_incident(self.rule)
        with refused(self):
            IncidentEvent.objects.create(incident=incident, kind="opened", at=at(61))
        for _ in range(2):  # a recovery may be observed and interrupted again and again
            IncidentEvent.objects.create(incident=incident, kind="recovery_started", at=at(100), health="healthy", reason="ok")
            IncidentEvent.objects.create(incident=incident, kind="recovery_interrupted", at=at(110), health="critical", reason="offline")
        with refused(self):
            IncidentEvent.objects.create(incident=incident, kind="recovery_started", at=at(120), actor=self.user, actor_name="operator")
        with refused(self):
            IncidentEvent.objects.create(incident=incident, kind="opened_twice", at=at(120))

    def test_deleting_the_user_who_acknowledged_keeps_the_record(self):
        incident = open_incident(self.rule)
        incident.acknowledge(self.user, at=at(90))
        self.user.delete()
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.acknowledged_at, incident.acknowledged_by), ("acknowledged", at(90), None))
        self.assertEqual(incident.events.get(kind="acknowledged").actor_name, "operator")

    def test_history_goes_with_its_incident_only(self):
        incident = open_incident(self.rule)
        incident.close("rule_disabled", at=at(120))
        incident.delete()
        self.assertFalse(IncidentEvent.objects.exists())


class EvaluationStateTests(TestCase):
    def setUp(self):
        self.rule = make_rule(reason="offline")

    def state(self, phase, **fields):
        values = {"entity_kind": "server", "entity_ref": ref(), "condition_health": "critical", "condition_since": at(0), "last_health": "critical", **fields}
        return AlertEvaluationState.objects.create(rule=self.rule, phase=phase, **values)

    def test_each_phase_has_what_it_needs_and_nothing_else(self):
        cause = open_incident(make_rule("Cause"))
        self.state("pending")
        self.state("firing", incident=open_incident(self.rule))
        self.state("recovering", incident=open_incident(self.rule), recovering_since=at(300), last_health="healthy")
        self.state("suppressed", suppressed_by=cause, last_health="unknown")
        for phase, fields in (
            ("pending", {"incident": open_incident(self.rule)}),
            ("firing", {}),
            ("firing", {"incident": open_incident(self.rule), "recovering_since": at(300)}),
            ("recovering", {"incident": open_incident(self.rule)}),
            ("recovering", {"incident": open_incident(self.rule), "recovering_since": at(-1)}),
            ("suppressed", {}),
            ("suppressed", {"suppressed_by": cause, "incident": open_incident(self.rule)}),
            ("pending", {"last_health": "offline"}),
            ("resting", {}),
        ):
            with self.subTest(phase=phase, fields=sorted(fields)), refused(self):
                self.state(phase, **fields)

    def test_one_state_per_rule_and_object_and_one_per_incident(self):
        server = ref()
        self.state("pending", entity_ref=server)
        with refused(self):
            self.state("pending", entity_ref=server)
        incident = open_incident(self.rule)
        self.state("firing", incident=incident)
        with refused(self):
            self.state("firing", incident=incident)


class VisibilityTests(TestCase):
    """Incidents are seen through the console's own access rules, by the site they happened on."""

    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.dc = Site.objects.create(customer=self.acme, name="DC")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.rule = make_rule(reason="offline")
        self.at_hq = open_incident(self.rule, site=self.hq, label="hq-host")
        self.at_dc = open_incident(self.rule, site=self.dc, label="dc-host")
        self.at_plant = open_incident(self.rule, site=self.plant, label="plant-host")
        self.nowhere = open_incident(self.rule, label="unassigned-host")

    def seen(self, user) -> list[str]:
        visible = Visibility.for_user(user).filter(Incident.objects.all(), site_path="site")
        return sorted(visible.values_list("entity_label", flat=True))

    def test_each_user_sees_the_incidents_of_their_sites(self):
        self.assertEqual(self.seen(make_user("acme", customers=[self.acme])), ["dc-host", "hq-host"])
        self.assertEqual(self.seen(make_user("hq", sites=[self.hq])), ["hq-host"])
        self.assertEqual(self.seen(make_user("none")), [])
        self.assertEqual(self.seen(make_user("no-console", console=False, all_customers=True)), [])

    def test_objects_on_no_site_are_seen_by_users_who_see_every_customer_only(self):
        everyone = make_user("all", all_customers=True)
        self.assertEqual(self.seen(everyone), ["dc-host", "hq-host", "plant-host", "unassigned-host"])
        self.assertNotIn("unassigned-host", self.seen(make_user("acme", customers=[self.acme])))

    def test_an_object_that_moves_leaves_its_incident_where_it_happened(self):
        acme_user = make_user("acme", customers=[self.acme])
        globex_user = make_user("globex", customers=[self.globex])
        stored = Incident.objects.get(pk=self.at_hq.pk)
        stored.site = self.plant
        with self.assertRaises(ImmutableIncident):
            stored.save()
        # The move ends the incident on the old site; the failure, if it goes on, is the new site's.
        self.at_hq.close("entity_moved", at=at(200))
        open_incident(self.rule, self.at_hq.entity_ref, site=self.plant, label="hq-host", started=200, opened=200)
        self.assertEqual(self.seen(acme_user), ["dc-host", "hq-host"])
        self.assertEqual(Visibility.for_user(acme_user).filter(Incident.objects.open(), site_path="site").count(), 1)
        self.assertEqual(self.seen(globex_user), ["hq-host", "plant-host"])
        moved = Visibility.for_user(globex_user).filter(Incident.objects.filter(entity_ref=self.at_hq.entity_ref), site_path="site")
        self.assertEqual([incident.site for incident in moved], [self.plant])

    def test_a_site_with_incidents_is_not_deleted_with_its_history(self):
        with self.assertRaises(ProtectedError):
            self.dc.delete()


class PermissionTests(TestCase):
    def test_acknowledging_is_a_permission_of_its_own(self):
        operator = make_user("operator")
        self.assertFalse(operator.has_perm("alerts.acknowledge_incident"))
        for name in (VIEWERS, VIEWERS_ALL):
            codenames = Group.objects.get(name=name).permissions.values_list("codename", flat=True)
            self.assertNotIn("acknowledge_incident", codenames, name)
        self.assertTrue(make_user("root", superuser=True).has_perm("alerts.acknowledge_incident"))

    def test_it_grants_no_console_access_or_data_by_itself(self):
        user = make_user("ack-only", console=False)
        user.user_permissions.add(Permission.objects.get(content_type__app_label="alerts", codename="acknowledge_incident"))
        user = type(user).objects.get(pk=user.pk)
        open_incident(make_rule())
        self.assertTrue(user.has_perm("alerts.acknowledge_incident"))
        self.assertEqual(list(Visibility.for_user(user).filter(Incident.objects.all(), site_path="site")), [])

    def test_the_engines_records_can_only_be_viewed_in_the_admin(self):
        codenames = set(
            django_apps.get_model("auth", "Permission").objects.filter(content_type__app_label="alerts").values_list("codename", flat=True)
        )
        self.assertEqual(
            codenames,
            {
                "add_alertrule",
                "change_alertrule",
                "delete_alertrule",
                "view_alertrule",
                "view_incident",
                "acknowledge_incident",
                "view_incidentevent",
                "view_alertevaluationstate",
                "view_alertengineheartbeat",
                "add_notificationsubscription",
                "change_notificationsubscription",
                "delete_notificationsubscription",
                "view_notificationsubscription",
                "view_notification",
            },
        )


class HeartbeatTests(TestCase):
    def test_there_is_one_heartbeat(self):
        beat = AlertEngineHeartbeat.objects.create(started_at=at(0))  # started, no cycle completed yet
        self.assertEqual((beat.beat_at, beat.monitoring_since), (None, None))
        AlertEngineHeartbeat.objects.filter(pk=1).update(beat_at=at(30), last_cycle_ms=40, monitoring_since=at(0))
        with refused(self):
            AlertEngineHeartbeat.objects.create(id=2, started_at=at(0), beat_at=at(30))


class SecretsTests(TestCase):
    SECRETISH = ("password", "secret", "token", "community", "credential", "smtp", "key_")

    def test_no_field_could_hold_a_secret(self):
        for model in django_apps.get_app_config("alerts").get_models():
            for field in model._meta.get_fields():
                with self.subTest(model=model.__name__, field=field.name):
                    self.assertFalse(any(word in field.name.lower() for word in self.SECRETISH))


class AdminTests(TestCase):
    def setUp(self):
        self.client.force_login(make_user("root", superuser=True))
        self.rule = make_rule(reason="offline")
        self.incident = open_incident(self.rule)
        AlertEvaluationState.objects.create(
            rule=self.rule,
            entity_kind="server",
            entity_ref=self.incident.entity_ref,
            phase="firing",
            incident=self.incident,
            condition_health="critical",
            condition_reason="offline",
            condition_since=at(0),
            last_health="critical",
        )
        AlertEngineHeartbeat.objects.create(started_at=at(0), beat_at=at(30))

    def test_the_admin_pages_load(self):
        for model in ("alertrule", "incident", "alertevaluationstate", "alertengineheartbeat"):
            with self.subTest(model=model):
                self.assertEqual(self.client.get(reverse(f"admin:alerts_{model}_changelist")).status_code, 200)
        self.assertEqual(self.client.get(reverse("admin:alerts_alertrule_change", args=[self.rule.pk])).status_code, 200)
        page = self.client.get(reverse("admin:alerts_incident_change", args=[self.incident.pk]))
        self.assertEqual(page.status_code, 200)
        self.assertContains(page, "Opened")

    def test_incidents_and_engine_records_are_read_only(self):
        with self.assertLogs("django.request", "WARNING"):
            self.assertEqual(self.client.get(reverse("admin:alerts_incident_add")).status_code, 403)
            self.assertEqual(self.client.get(reverse("admin:alerts_incident_delete", args=[self.incident.pk])).status_code, 403)
        page = self.client.get(reverse("admin:alerts_incident_change", args=[self.incident.pk]))
        self.assertNotContains(page, 'name="_save"')

    def test_a_rules_kind_is_fixed_once_it_exists(self):
        page = self.client.get(reverse("admin:alerts_alertrule_change", args=[self.rule.pk]))
        self.assertNotContains(page, 'name="entity_kind"')
        self.assertContains(self.client.get(reverse("admin:alerts_alertrule_add")), 'name="entity_kind"')
