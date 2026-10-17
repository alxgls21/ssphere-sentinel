"""The alert engine, cycle by cycle, against real monitoring data at explicit moments."""

from datetime import timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.alerts import engine
from apps.alerts.engine import Verdict, verdict
from apps.alerts.models import AlertEngineHeartbeat, AlertEvaluationState, AlertRule, Incident
from apps.alerts.observations import Observation
from apps.alerts.tests.fleet import EngineTestCase, evaluate, incidents, t
from apps.console.tests.helpers import make_user
from apps.infrastructure.models import DockerContainer
from apps.network.models import NetworkTarget
from apps.snmp.models import SnmpConfig


def state(**filters) -> AlertEvaluationState:
    return AlertEvaluationState.objects.get(**filters)


class ServerOfflineTests(EngineTestCase):
    """The default rule: activation 60 s, recovery 120 s, offline after 90 s of silence."""

    def setUp(self):
        super().setUp()
        self.rule = self.enable("server-offline")
        self.server = self.fleet.server("web-1", site=self.fleet.hq, seen=0)

    def open_incident(self) -> Incident:
        evaluate(91)
        evaluate(150)
        return Incident.objects.get()

    def test_the_condition_must_hold_for_the_activation_time(self):
        evaluate(80)
        self.assertFalse(AlertEvaluationState.objects.exists())
        evaluate(91)  # silent since t(0): offline from t(90)
        pending = state()
        self.assertEqual((pending.phase, pending.condition_since), ("pending", t(90)))
        evaluate(149)
        self.assertEqual(incidents(), [])
        evaluate(150)
        [incident] = incidents()
        self.assertEqual((incident.status, incident.started_at, incident.opened_at), ("active", t(90), t(150)))
        self.assertEqual((incident.entity_label, incident.site_id, incident.severity), ("web-1", self.fleet.hq.pk, "critical"))
        self.assertEqual((incident.condition_health, incident.condition_reason), ("critical", "offline"))
        self.assertEqual((state().phase, state().incident), ("firing", incident))

    def test_one_continuous_failure_is_one_incident(self):
        self.open_incident()
        for at in (180, 240, 600, 3600):
            evaluate(at)
        self.assertEqual(len(incidents()), 1)
        self.assertEqual(self.kinds(Incident.objects.get()), ["opened"])

    def test_recovery_must_be_observed_for_the_recovery_time(self):
        incident = self.open_incident()
        self.fleet.heartbeat(self.server, 700)
        evaluate(700)
        self.assertEqual((state().phase, state().recovering_since), ("recovering", t(700)))
        self.fleet.heartbeat(self.server, 819)
        evaluate(819)
        self.assertTrue(Incident.objects.get().is_open)
        self.fleet.heartbeat(self.server, 820)
        evaluate(820)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.recovered_at, incident.closed_at), ("recovered", t(700), t(820)))
        self.assertEqual(self.kinds(incident), ["opened", "recovery_started", "recovered"])
        self.assertFalse(AlertEvaluationState.objects.exists())

    def test_the_same_reading_evaluated_again_is_no_newer_evidence(self):
        self.open_incident()
        self.fleet.heartbeat(self.server, 700)
        evaluate(700)
        # Heartbeats go on without a new resource reading: the one from t(700) is all there is.
        for at in (730, 760, 789):
            self.fleet.heartbeat(self.server, at, cpu=None)
            evaluate(at)
        self.assertEqual((state().phase, state().recovering_since), ("recovering", t(700)))
        self.assertTrue(Incident.objects.get().is_open)

    def test_unknown_is_never_a_recovery(self):
        incident = self.open_incident()
        # Back, but without a current resource reading: alive, its health unknown.
        for at in (700, 800, 900):
            self.fleet.heartbeat(self.server, at, cpu=None)
            evaluate(at)
        incident.refresh_from_db()
        self.assertEqual((incident.status, self.kinds(incident)), ("active", ["opened"]))
        self.assertEqual(state().phase, "firing")

    def test_missing_data_interrupts_a_recovery(self):
        incident = self.open_incident()
        self.fleet.heartbeat(self.server, 700)
        evaluate(700)
        self.fleet.heartbeat(self.server, 795, cpu=None)  # the reading from t(700) is no longer current
        evaluate(795)
        self.assertEqual((state().phase, state().recovering_since), ("firing", None))
        self.fleet.heartbeat(self.server, 800)
        evaluate(800)
        self.fleet.heartbeat(self.server, 920)
        evaluate(920)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.recovered_at), ("recovered", t(800)))
        self.assertEqual(self.kinds(incident), ["opened", "recovery_started", "recovery_interrupted", "recovery_started", "recovered"])

    def test_a_server_never_seen_is_not_offline(self):
        self.fleet.server("new-1", seen=None)
        for at in (91, 500, 5000):
            evaluate(at)
        self.assertEqual([incident.entity_label for incident in incidents()], ["web-1"])

    def test_an_acknowledgement_stays_while_the_incident_is_open_and_after(self):
        incident = self.open_incident()
        operator = make_user("operator")
        self.assertTrue(incident.acknowledge(operator, at=t(160)))
        for at in (200, 400):
            evaluate(at)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.acknowledged_at, incident.acknowledged_by), ("acknowledged", t(160), operator))
        self.fleet.heartbeat(self.server, 700)
        evaluate(700)
        self.fleet.heartbeat(self.server, 820)
        evaluate(820)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.acknowledged_by), ("recovered", operator))

    def test_a_later_failure_is_a_new_incident(self):
        first = self.open_incident()
        self.fleet.heartbeat(self.server, 700)
        evaluate(700)
        self.fleet.heartbeat(self.server, 820)
        evaluate(820)
        evaluate(911)  # silent again since t(820)
        evaluate(970)
        second = Incident.objects.open().get()
        self.assertNotEqual(second.pk, first.pk)
        self.assertEqual((second.started_at, second.opened_at), (t(910), t(970)))
        self.assertEqual(Incident.objects.get(pk=first.pk).status, "recovered")

    def test_an_open_incident_without_a_state_is_taken_up_not_duplicated(self):
        incident = self.open_incident()
        AlertEvaluationState.objects.all().delete()
        evaluate(200)
        self.assertEqual(incidents(), [incident])
        self.assertEqual((state().phase, state().incident), ("firing", incident))

    def test_without_activation_time_the_incident_opens_at_once(self):
        self.rule.activation_seconds = 0
        self.rule.save()
        evaluate(91)
        self.assertEqual(Incident.objects.get().opened_at, t(91))


class StormTests(EngineTestCase):
    """After a restart, or while Sentinel receives nothing, silences wait for the agents to report."""

    def setUp(self):
        super().setUp()
        self.enable("server-offline")
        self.reporting = self.fleet.server("reports-again", seen=0)
        self.dead = self.fleet.server("really-down", seen=0)

    def test_after_a_restart_every_agent_first_gets_the_offline_threshold_to_report(self):
        # Sentinel was down from t(0) to t(1000): every server's last heartbeat is old.
        evaluate(1000, since=1000)
        self.assertFalse(AlertEvaluationState.objects.exists())
        self.fleet.heartbeat(self.reporting, 1030)
        evaluate(1089, since=1000)
        self.assertFalse(AlertEvaluationState.objects.exists())
        evaluate(1090, since=1000)
        self.assertEqual(state().condition_since, t(1090))
        evaluate(1150, since=1000)
        [incident] = incidents()
        self.assertEqual((incident.entity_label, incident.started_at), ("really-down", t(1090)))

    def test_without_the_window_the_same_restart_would_be_a_storm(self):
        evaluate(1000)
        self.assertEqual(len(incidents()), 2)

    def test_while_the_ingest_looks_down_no_silence_counts_and_open_incidents_stay(self):
        evaluate(91)
        evaluate(150)
        opened = set(Incident.objects.open().values_list("pk", flat=True))
        self.fleet.server("third", seen=4000)  # silent since t(4000) too
        evaluate(5000, since=None)
        self.assertEqual(set(Incident.objects.open().values_list("pk", flat=True)), opened)
        self.assertFalse(AlertEvaluationState.objects.filter(phase="pending").exists())

    def test_the_window_starts_again_after_a_break(self):
        heartbeat = AlertEngineHeartbeat(started_at=t(0), beat_at=t(1000), monitoring_since=t(0))
        gap = timedelta(seconds=90)
        self.assertEqual(engine.monitoring_window(t(1030), heartbeat, gap=gap), t(0))
        self.assertEqual(engine.monitoring_window(t(1091), heartbeat, gap=gap), t(1091))  # stopped, or failing
        self.assertEqual(engine.monitoring_window(t(1030), None, gap=gap), t(1030))  # first start
        heartbeat.monitoring_since = None  # the ingest was down
        self.assertEqual(engine.monitoring_window(t(1030), heartbeat, gap=gap), t(1030))

    def test_the_ingest_looks_down_when_nearly_every_agent_falls_silent_at_once(self):
        # Two agents: a failure of both is theirs, not Sentinel's.
        self.assertFalse(engine.ingest_silent(t(200)))
        third = self.fleet.server("third", seen=0)
        self.assertTrue(engine.ingest_silent(t(200)))
        self.fleet.heartbeat(third, 190)
        self.assertFalse(engine.ingest_silent(t(200)))
        for index in range(7):
            self.fleet.server(f"more-{index}", seen=0)
        # One of ten still reporting (the agent on Sentinel's own host, say): still Sentinel's outage.
        self.assertTrue(engine.ingest_silent(t(200)))
        # Agents silent for more than a day no longer count.
        self.assertFalse(engine.ingest_silent(t(200) + engine.OUTAGE_LOOKBACK))
        self.assertEqual(engine.monitoring_window(t(200), None, gap=timedelta(seconds=90)), None)


class SuppressionTests(EngineTestCase):
    """A failure that is a consequence of an unavailable monitoring source is not an incident of its own."""

    def setUp(self):
        super().setUp()
        self.enable("server-offline", activation_seconds=0)
        self.probe = self.fleet.server("probe-1", site=self.fleet.hq, seen=0)

    def unknown_rule(self, kind: str) -> AlertRule:
        return AlertRule.objects.create(name=f"{kind} without data", entity_kind=kind, health="unknown", severity="warning", activation_seconds=0)

    def test_an_agent_outage_is_one_incident_not_one_per_target_and_device(self):
        self.enable("target-failing", activation_seconds=0)
        self.enable("device-unreachable", activation_seconds=0)
        target = self.fleet.target("gateway", self.probe, site=self.fleet.hq)
        self.fleet.measure(target, 0, success=False)
        device = self.fleet.device("core-sw", self.probe, site=self.fleet.hq)
        self.fleet.poll(device, 0, reachable=False)
        targets_unknown, devices_unknown = self.unknown_rule("target"), self.unknown_rule("device")
        evaluate(200)
        [server_incident] = incidents()
        self.assertEqual(server_incident.entity_kind, "server")
        for rule, kind in ((targets_unknown, "target"), (devices_unknown, "device")):
            suppressed = state(rule=rule)
            self.assertEqual((suppressed.phase, suppressed.suppressed_by, suppressed.last_reason), ("suppressed", server_incident, "agent_offline"))
        # The agent reports again: nothing is suppressed any more, and nothing opened meanwhile.
        self.fleet.heartbeat(self.probe, 300)
        self.fleet.measure(target, 300)
        self.fleet.poll(device, 300)
        evaluate(300)
        self.assertFalse(AlertEvaluationState.objects.filter(phase="suppressed").exists())
        self.assertEqual(Incident.objects.exclude(entity_kind="server").count(), 0)

    def test_containers_of_an_offline_host_are_suppressed_and_an_unavailable_docker_is_not(self):
        containers_unknown = self.unknown_rule("container")
        self.fleet.docker(self.probe, 0)
        self.fleet.container(self.probe, "api")
        other = self.fleet.server("docker-2", site=self.fleet.hq, seen=200)
        self.fleet.docker(other, 200, available=False)
        self.fleet.container(other, "worker")
        evaluate(200)
        server_incident = Incident.objects.get(entity_kind="server")
        self.assertEqual(state(rule=containers_unknown, phase="suppressed").suppressed_by, server_incident)
        [container_incident] = incidents(entity_kind="container")
        self.assertEqual(container_incident.entity_label, "worker on docker-2")

    def test_interfaces_of_an_unreachable_device_are_suppressed_by_its_incident(self):
        self.enable("device-unreachable", activation_seconds=0)
        interfaces_unknown = self.unknown_rule("interface")
        device = self.fleet.device("core-sw", self.probe, site=self.fleet.hq)
        self.fleet.interface(device, 1)
        self.fleet.interface(device, 2, oper=2)
        self.fleet.poll(device, 0, reachable=False)
        evaluate(30)
        device_incident = Incident.objects.get(entity_kind="device")
        self.assertEqual(
            list(AlertEvaluationState.objects.filter(rule=interfaces_unknown).values_list("phase", "suppressed_by", "entity_ref").order_by("entity_ref")),
            [("suppressed", device_incident.pk, f"{device.pk}:1"), ("suppressed", device_incident.pk, f"{device.pk}:2")],
        )
        self.assertFalse(Incident.objects.filter(entity_kind="interface").exists())

    def test_without_an_open_incident_of_the_source_nothing_is_raised_either(self):
        targets_unknown = self.unknown_rule("target")
        AlertRule.objects.filter(key="server-offline").update(enabled=False)
        target = self.fleet.target("gateway", self.probe, site=self.fleet.hq)
        self.fleet.measure(target, 0)
        evaluate(200)
        self.assertFalse(Incident.objects.exists())
        self.assertFalse(AlertEvaluationState.objects.filter(rule=targets_unknown).exists())


class RuleChangeTests(EngineTestCase):
    def setUp(self):
        super().setUp()
        self.rule = self.enable("server-offline")
        self.server = self.fleet.server("web-1", site=self.fleet.hq, seen=0)
        evaluate(91)
        evaluate(150)
        self.incident = Incident.objects.get()

    def test_a_disabled_rule_closes_its_incidents_and_forgets_its_states(self):
        self.rule.enabled = False
        self.rule.save()
        evaluate(200)
        self.incident.refresh_from_db()
        self.assertEqual((self.incident.status, self.incident.close_reason, self.incident.closed_at), ("closed", "rule_disabled", t(200)))
        self.assertEqual(self.kinds(self.incident), ["opened", "closed"])
        self.assertFalse(AlertEvaluationState.objects.exists())

    def test_a_changed_condition_or_severity_closes_the_incident_and_starts_again(self):
        self.rule.severity = "warning"
        self.rule.save()
        evaluate(200)
        self.incident.refresh_from_db()
        self.assertEqual((self.incident.status, self.incident.close_reason), ("closed", "rule_changed"))
        # Offline since t(90) under the new definition too: its incident opens with it.
        renewed = Incident.objects.open().get()
        self.assertEqual((renewed.severity, renewed.started_at, renewed.opened_at), ("warning", t(90), t(200)))

    def test_a_change_of_name_or_timing_is_not_material(self):
        self.rule.name = "Hosts offline"
        self.rule.activation_seconds = 300
        self.rule.recovery_seconds = 600
        self.rule.save()
        evaluate(200)
        self.assertEqual(list(Incident.objects.open()), [self.incident])

    def test_a_pending_state_starts_over_when_the_condition_changes(self):
        target_rule = self.enable("target-failing", activation_seconds=600)
        target = self.fleet.target("gateway", self.server, site=self.fleet.hq)
        self.fleet.heartbeat(self.server, 200)
        for at in (100, 140, 180):
            self.fleet.measure(target, at, success=False)
        evaluate(200)
        self.assertEqual(state(rule=target_rule).condition_since, t(180))
        target_rule.reason = ""
        target_rule.save()
        self.fleet.measure(target, 230, success=False)
        self.fleet.heartbeat(self.server, 230)
        evaluate(230)
        pending = state(rule=target_rule)
        self.assertEqual((pending.phase, pending.condition_reason, pending.condition_since), ("pending", "", t(230)))


class ObjectChangeTests(EngineTestCase):
    def test_an_object_that_is_deleted_or_no_longer_monitored_ends_its_incident(self):
        self.enable("target-failing", activation_seconds=0)
        self.enable("device-unreachable", activation_seconds=0)
        self.enable("container-failed", activation_seconds=0)
        probe = self.fleet.server("probe-1", seen=0)
        target = self.fleet.target("gateway", probe)
        for at in (0, 10, 20):
            self.fleet.measure(target, at, success=False)
        device = self.fleet.device("core-sw", probe)
        self.fleet.poll(device, 20, reachable=False)
        self.fleet.docker(probe, 20)
        container = self.fleet.container(probe, "api", state="dead", at=20)
        evaluate(30)
        self.assertEqual(Incident.objects.open().count(), 3)
        NetworkTarget.objects.filter(pk=target.pk).delete()
        SnmpConfig.objects.filter(device=device).delete()
        DockerContainer.objects.filter(pk=container.pk).update(present=False)
        evaluate(40)
        self.assertEqual(
            sorted(Incident.objects.values_list("entity_kind", "status", "close_reason")),
            [("container", "closed", "entity_removed"), ("device", "closed", "entity_removed"), ("target", "closed", "entity_removed")],
        )

    def test_an_object_that_moves_ends_its_incident_there_and_opens_one_on_the_new_site(self):
        self.enable("server-offline")
        server = self.fleet.server("web-1", site=self.fleet.hq, seen=0)
        evaluate(91)
        evaluate(150)
        old = Incident.objects.get()
        self.fleet.move(server, self.fleet.plant)
        evaluate(200)
        old.refresh_from_db()
        self.assertEqual((old.status, old.close_reason, old.site_id), ("closed", "entity_moved", self.fleet.hq.pk))
        new = Incident.objects.open().get()
        self.assertEqual((new.site_id, new.started_at, new.opened_at), (self.fleet.plant.pk, t(200), t(200)))

    def test_an_object_that_leaves_the_rules_scope_ends_its_incident(self):
        scoped = AlertRule.objects.create(
            name="Acme servers offline", entity_kind="server", health="critical", reason="offline",
            severity="critical", activation_seconds=0, customer=self.fleet.acme,
        )
        server = self.fleet.server("web-1", site=self.fleet.hq, seen=0)
        evaluate(91)
        incident = Incident.objects.get(rule=scoped)
        self.fleet.move(server, self.fleet.plant)
        evaluate(120)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.close_reason), ("closed", "out_of_scope"))
        self.assertFalse(Incident.objects.open().exists())

    def test_a_disabled_or_stopped_object_ends_its_incident_without_a_recovery(self):
        self.enable("target-failing", activation_seconds=0)
        self.enable("container-failed", activation_seconds=0)
        probe = self.fleet.server("probe-1", seen=0)
        target = self.fleet.target("gateway", probe)
        for at in (0, 10, 20):
            self.fleet.measure(target, at, success=False)
        self.fleet.docker(probe, 20)
        container = self.fleet.container(probe, "api", state="running", health="unhealthy", at=20)
        evaluate(30)
        NetworkTarget.objects.filter(pk=target.pk).update(enabled=False)
        self.fleet.set_container(container, 40, state="exited", health="none")
        self.fleet.docker(probe, 40)
        self.fleet.heartbeat(probe, 40)
        evaluate(40)
        self.assertEqual(
            sorted(Incident.objects.values_list("entity_kind", "status", "close_reason", "recovered_at")),
            [("container", "closed", "entity_disabled", None), ("target", "closed", "entity_disabled", None)],
        )


class ScopeTests(EngineTestCase):
    def test_a_rule_sees_only_its_customer_or_site(self):
        by_customer = AlertRule.objects.create(
            name="Acme offline", entity_kind="server", health="critical", reason="offline", severity="critical",
            activation_seconds=0, customer=self.fleet.acme,
        )
        by_site = AlertRule.objects.create(
            name="DC offline", entity_kind="server", health="critical", reason="offline", severity="critical",
            activation_seconds=0, site=self.fleet.dc,
        )
        for name, site in (("hq-1", self.fleet.hq), ("dc-1", self.fleet.dc), ("plant-1", self.fleet.plant), ("nowhere-1", None)):
            self.fleet.server(name, site=site, seen=0)
        evaluate(91)
        self.assertEqual(sorted(i.entity_label for i in incidents(rule=by_customer)), ["dc-1", "hq-1"])
        self.assertEqual([i.entity_label for i in incidents(rule=by_site)], ["dc-1"])


class ContainerTests(EngineTestCase):
    def test_a_restart_is_no_recovery_until_the_container_runs_again(self):
        self.enable("container-failed")
        host = self.fleet.server("docker-1", seen=0)
        self.fleet.docker(host, 0)
        container = self.fleet.container(host, "api", state="running", health="unhealthy", at=0)

        def report(at, **fields):
            if fields:
                self.fleet.set_container(container, at, **fields)
            self.fleet.docker(host, at)
            self.fleet.heartbeat(host, at)
            evaluate(at)

        report(0)
        report(30)
        self.assertEqual(state().phase, "pending")
        report(60)
        incident = Incident.objects.get()
        report(120, health="starting")  # restarted: its health check has not passed yet
        self.assertEqual(state().phase, "firing")
        report(180, health="healthy")
        self.assertEqual((state().phase, state().recovering_since), ("recovering", t(180)))
        report(300)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.recovered_at, incident.closed_at), ("recovered", t(180), t(300)))


class SnmpPollingTests(EngineTestCase):
    """The default rule: unreachable for 600 s, measured on the polls (five minutes apart)."""

    def setUp(self):
        super().setUp()
        self.rule = self.enable("device-unreachable")
        self.assertEqual(self.rule.activation_seconds, 600)
        self.probe = self.fleet.server("probe-1", seen=0)
        self.device = self.fleet.device("core-sw", self.probe, interval=300)

    def at(self, seconds, *, poll=None):
        if poll is not None:
            self.fleet.poll(self.device, seconds, reachable=poll)
        self.fleet.heartbeat(self.probe, seconds)  # the agent reports throughout
        evaluate(seconds)

    def test_three_failed_polls_ten_minutes_apart_however_often_evaluated(self):
        self.at(0, poll=False)
        for seconds in range(30, 300, 30):
            self.at(seconds)
        self.assertEqual(state().condition_since, t(0))
        self.at(300, poll=False)
        for seconds in range(330, 600, 30):
            self.at(seconds)
        self.assertFalse(Incident.objects.exists())
        self.at(600, poll=False)
        incident = Incident.objects.get()
        self.assertEqual((incident.started_at, incident.opened_at), (t(0), t(600)))

    def test_the_same_failed_poll_evaluated_again_is_not_a_new_failure(self):
        self.at(0, poll=False)
        self.at(300, poll=False)
        # No poll since t(300): ten, fifteen, twenty minutes after the first failure, nothing new was observed.
        for seconds in (600, 900, 1199):
            self.at(seconds)
        self.assertFalse(Incident.objects.exists())
        self.assertEqual(state().phase, "pending")
        # Three intervals after the last poll it is stale: no current data, and the pending condition is forgotten.
        self.at(1201)
        self.assertFalse(AlertEvaluationState.objects.exists())

    def test_recovery_is_measured_on_the_polls_too(self):
        for seconds in (0, 300, 600):
            self.at(seconds, poll=False)
        incident = Incident.objects.get()
        self.at(900, poll=True)
        self.assertEqual((state().phase, state().recovering_since), ("recovering", t(900)))
        self.at(1000)  # the same poll: no newer evidence
        self.assertTrue(Incident.objects.get().is_open)
        self.at(1200, poll=True)
        incident.refresh_from_db()
        self.assertEqual((incident.status, incident.recovered_at, incident.closed_at), ("recovered", t(900), t(1200)))


class ResourceAndInterfaceTests(EngineTestCase):
    def test_an_offline_server_says_nothing_about_its_resources(self):
        cpu = AlertRule.objects.create(
            name="CPU", entity_kind="server", health="critical", reason="resources", severity="critical", activation_seconds=0, recovery_seconds=0
        )
        server = self.fleet.server("busy-1", seen=0, cpu=99)
        evaluate(10)
        incident = Incident.objects.get(rule=cpu)
        evaluate(500)  # offline: no current reading, so neither failing nor recovered
        self.assertEqual((state(rule=cpu).phase, Incident.objects.get(pk=incident.pk).status), ("firing", "active"))
        self.fleet.heartbeat(server, 600, cpu=10)
        evaluate(600)
        self.assertEqual(Incident.objects.get(pk=incident.pk).status, "recovered")

    def test_an_interface_down_on_a_reachable_device(self):
        down = AlertRule.objects.create(
            name="Ports down", entity_kind="interface", health="warning", reason="down", severity="warning", activation_seconds=0, recovery_seconds=0
        )
        probe = self.fleet.server("probe-1", seen=0)
        device = self.fleet.device("core-sw", probe)
        port = self.fleet.interface(device, 7, oper=2)
        self.fleet.interface(device, 8, admin=2, oper=2)  # administratively down: not a failure
        self.fleet.poll(device, 0)
        evaluate(10)
        incident = Incident.objects.get(rule=down)
        self.assertEqual((incident.entity_ref, incident.entity_label), (f"{device.pk}:7", "Gi0/7 on core-sw"))
        type(port).objects.filter(pk=port.pk).update(oper_status=1)
        self.fleet.poll(device, 60)
        self.fleet.heartbeat(probe, 60)
        evaluate(60)
        self.assertEqual(Incident.objects.get(pk=incident.pk).status, "recovered")


class VerdictTests(EngineTestCase):
    def obs(self, kind="server", health="critical", reason="offline", **extra):
        return Observation(kind=kind, ref="x", label="x", site_id=None, customer_id=None, health=health, reason=reason, evidence_at=t(0), **extra)

    def test_what_each_observation_says_about_a_rule(self):
        offline = AlertRule(entity_kind="server", health="critical", reason="offline")
        resources = AlertRule(entity_kind="server", health="critical", reason="resources")
        unknown_targets = AlertRule(entity_kind="target", health="unknown", reason="")
        failing = AlertRule(entity_kind="target", health="critical", reason="failing")
        cases = (
            (offline, self.obs(), Verdict.MATCH),
            (offline, self.obs(health="healthy", reason="ok"), Verdict.CLEAR),
            (offline, self.obs(health="critical", reason="resources"), Verdict.CLEAR),
            (offline, self.obs(health="unknown", reason="no_telemetry"), Verdict.INDETERMINATE),
            (offline, self.obs(health="unknown", reason="never_seen"), Verdict.INDETERMINATE),
            (resources, self.obs(), Verdict.INDETERMINATE),
            (failing, self.obs(kind="target", health="idle", reason="disabled"), Verdict.DORMANT),
            (failing, self.obs(kind="target", health="warning", reason="failed"), Verdict.CLEAR),
            (failing, self.obs(kind="target", health="unknown", reason="stale"), Verdict.INDETERMINATE),
            (unknown_targets, self.obs(kind="target", health="unknown", reason="stale"), Verdict.MATCH),
            (unknown_targets, self.obs(kind="target", health="unknown", reason="agent_offline", upstream=("server", "s")), Verdict.DEPENDENT),
            (unknown_targets, self.obs(kind="target", health="healthy", reason="ok"), Verdict.CLEAR),
        )
        for rule, obs, expected in cases:
            with self.subTest(rule=(rule.entity_kind, rule.health, rule.reason), obs=(obs.health, obs.reason)):
                self.assertEqual(verdict(rule, obs), expected)


class CostTests(EngineTestCase):
    def test_a_quiet_estate_costs_the_same_few_queries_however_large(self):
        for key in ("server-offline", "target-failing", "device-unreachable", "container-failed"):
            self.enable(key)

        def grow(prefix, count):
            for index in range(count):
                server = self.fleet.server(f"{prefix}-{index}", site=self.fleet.hq, seen=0)
                self.fleet.docker(server, 0)
                self.fleet.container(server, f"app-{index}")
                target = self.fleet.target(f"{prefix}-target-{index}", server)
                self.fleet.measure(target, 0)
                self.fleet.poll(self.fleet.device(f"{prefix}-device-{index}", server), 0)

        grow("small", 3)
        with CaptureQueriesContext(connection) as small:
            evaluate(30)
        grow("large", 30)
        with CaptureQueriesContext(connection) as large:
            evaluate(31)
        self.assertEqual(len(small), len(large))
        self.assertLessEqual(len(large), 16)
        self.assertFalse(AlertEvaluationState.objects.exists())
