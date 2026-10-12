import random
import threading
from datetime import datetime
from unittest.mock import patch

from django.db import IntegrityError, OperationalError, connection
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext

from apps.snmp import reports
from apps.snmp.models import (
    DevicePoll,
    DeviceSnmpState,
    Interface,
    InterfaceSample,
)
from apps.snmp.reports import REASON_DEVICE_DISABLED, apply_snmp_report, validate_snmp_payload
from apps.snmp.tests.helpers import (
    RAW,
    counters,
    ingest,
    interface,
    make_agent,
    make_device,
    poll,
    report,
)


def when(payload) -> datetime:
    return datetime.fromisoformat(payload["measured_at"])


class IngestTestCase(TestCase):
    def setUp(self):
        self.agent, self.token = make_agent()
        self.device = make_device(self.agent)

    def state(self, device=None):
        return DeviceSnmpState.objects.get(pk=(device or self.device).pk)

    def interface(self, if_index, device=None):
        return Interface.objects.get(device=device or self.device, if_index=if_index)

    def outcomes(self, result):
        return {entry["poll_id"]: entry for entry in result.results()}


class StorageTests(IngestTestCase):
    def test_a_poll_is_stored_with_its_samples_interfaces_and_state(self):
        payload = poll(self.device, [interface(1, alias="uplink"), interface(2, with_counters=False)])
        result = ingest(self.agent, [payload])

        self.assertEqual((result.status, result.created, result.duplicates, result.rejected), ("accepted", 1, 0, 0))
        self.assertEqual(result.results(), [{"poll_id": payload["poll_id"], "result": "created"}])

        stored = DevicePoll.objects.get()
        self.assertEqual(str(stored.pk), payload["poll_id"])
        self.assertEqual(stored.device, self.device)
        self.assertEqual(stored.measured_at, when(payload))
        self.assertTrue(stored.reachable)
        self.assertEqual((stored.response_ms, stored.error, stored.sys_uptime_ticks), (12.5, "", 8_123_456))
        self.assertIsNotNone(stored.received_at)

        first = self.interface(1)
        self.assertEqual((first.name, first.alias, first.if_type, first.speed_bps), ("Gi0/1", "uplink", 6, 1_000_000_000))
        self.assertEqual((first.admin_status, first.oper_status, first.present), (1, 1, True))
        self.assertEqual(Interface.objects.count(), 2)
        # Only the interface that carries counters gets a sample.
        self.assertEqual(InterfaceSample.objects.count(), 1)

        state = self.state()
        self.assertEqual((state.last_poll_at, state.last_success_at), (when(payload), when(payload)))
        self.assertEqual(
            (state.reachable, state.error, state.response_ms, state.sys_uptime_ticks),
            (True, "", 12.5, 8_123_456),
        )
        self.assertEqual(
            (state.sys_name, state.sys_descr, state.sys_object_id),
            ("core-sw-1", "Cisco IOS XE Software, Version 17.9.4", "1.3.6.1.4.1.9.1.2504"),
        )

    def test_raw_counters_and_deltas_are_stored_exactly(self):
        raw = {"in_octets": 2**63 - 1, "out_octets": 7, "in_errors": 2**32 - 1, "out_errors": 0, "in_discards": 1, "out_discards": None}
        delta = {"in_octets": 2**62, "out_octets": 7, "in_errors": 5, "out_errors": 0, "in_discards": 1, "out_discards": None}
        payload = poll(self.device, [interface(1, counters=counters(raw=raw, delta=delta, interval=299.75))])
        ingest(self.agent, [payload])

        sample = InterfaceSample.objects.get()
        self.assertEqual(
            {name: getattr(sample, name) for name in raw},
            raw,
        )
        self.assertEqual(
            {name: getattr(sample, f"{name}_delta") for name in delta},
            delta,
        )
        self.assertEqual((sample.octets_bits, sample.delta_state, sample.interval_seconds), (64, "ok", 299.75))
        self.assertEqual((sample.measured_at, sample.speed_bps), (when(payload), 1_000_000_000))
        self.assertEqual((sample.admin_status, sample.oper_status), (1, 1))

    def test_invalid_delta_states_store_raw_counters_without_deltas(self):
        for minutes, state in ((6, "first"), (5, "reboot"), (4, "reset"), (3, "gap")):
            ingest(self.agent, [poll(self.device, [interface(1, counters=counters(state, interval=None))], minutes=minutes)])
        samples = {s.delta_state: s for s in InterfaceSample.objects.all()}
        self.assertEqual(set(samples), {"first", "reboot", "reset", "gap"})
        for sample in samples.values():
            self.assertEqual(sample.in_octets, RAW["in_octets"])
            self.assertIsNone(sample.in_octets_delta)
            self.assertIsNone(sample.interval_seconds)

    def test_speed_change_keeps_each_samples_own_speed(self):
        ingest(self.agent, [poll(self.device, [interface(1, speed=1_000_000_000)], minutes=10)])
        ingest(
            self.agent,
            [poll(self.device, [interface(1, speed=10_000_000_000, counters=counters("speed_changed"))], minutes=5)],
        )
        self.assertEqual(self.interface(1).speed_bps, 10_000_000_000)
        speeds = list(InterfaceSample.objects.order_by("measured_at").values_list("speed_bps", "delta_state"))
        self.assertEqual(speeds, [(1_000_000_000, "ok"), (10_000_000_000, "speed_changed")])

    def test_an_unreachable_poll_is_history_and_keeps_the_last_known_identity(self):
        good = poll(self.device, minutes=10)
        down = poll(self.device, reachable=False, error="auth_failure", response_ms=5000.0, minutes=5)
        self.assertEqual(ingest(self.agent, [good, down]).created, 2)

        state = self.state()
        self.assertEqual(state.last_poll_at, when(down))
        self.assertEqual(state.last_success_at, when(good))
        self.assertEqual((state.reachable, state.error, state.response_ms), (False, "auth_failure", 5000.0))
        self.assertIsNone(state.sys_uptime_ticks)  # stale: unknown now
        self.assertEqual(state.sys_name, "core-sw-1")  # identity is kept
        down_row = DevicePoll.objects.get(pk=down["poll_id"])
        self.assertFalse(down_row.reachable)
        self.assertEqual(down_row.error, "auth_failure")

    def test_several_devices_and_polls_in_one_report(self):
        second = make_device(self.agent, "edge-rtr", management_address="192.0.2.11")
        polls = [
            poll(self.device, minutes=3),
            poll(self.device, minutes=2),
            poll(second, [interface(10), interface(11)], minutes=2),
        ]
        result = ingest(self.agent, polls)
        self.assertEqual(result.created, 3)
        self.assertEqual(DevicePoll.objects.count(), 3)
        self.assertEqual(Interface.objects.filter(device=second).count(), 2)
        self.assertEqual(DeviceSnmpState.objects.count(), 2)
        self.assertEqual(InterfaceSample.objects.count(), 2 + 1 + 1)

    def test_an_empty_report_stores_nothing(self):
        result = ingest(self.agent, [])
        self.assertEqual((result.status, result.accepted, result.rejected, result.results()), ("accepted", 0, 0, []))
        self.assertFalse(DevicePoll.objects.exists())


class IdempotencyTests(IngestTestCase):
    def test_a_poll_resent_is_acknowledged_and_not_stored_twice(self):
        payload = poll(self.device)
        ingest(self.agent, [payload])
        before = (DevicePoll.objects.count(), InterfaceSample.objects.count(), Interface.objects.count())
        result = ingest(self.agent, [payload])
        self.assertEqual((result.status, result.created, result.duplicates), ("accepted", 0, 1))
        self.assertEqual(result.results(), [{"poll_id": payload["poll_id"], "result": "duplicate"}])
        self.assertEqual(
            (DevicePoll.objects.count(), InterfaceSample.objects.count(), Interface.objects.count()), before
        )

    def test_new_and_resent_polls_in_one_report_are_classified_separately(self):
        old = poll(self.device, minutes=5)
        ingest(self.agent, [old])
        new = poll(self.device, minutes=4)
        result = ingest(self.agent, [old, new])
        outcomes = self.outcomes(result)
        self.assertEqual(outcomes[old["poll_id"]]["result"], "duplicate")
        self.assertEqual(outcomes[new["poll_id"]]["result"], "created")
        self.assertEqual(DevicePoll.objects.count(), 2)

    def test_a_resend_never_moves_the_state(self):
        old = poll(self.device, [interface(1, oper=1)], minutes=10)
        new = poll(self.device, [interface(1, oper=2)], minutes=5)
        ingest(self.agent, [old, new])
        ingest(self.agent, [old])  # late resend of the older poll
        self.assertEqual(self.state().last_poll_at, when(new))
        self.assertEqual(self.interface(1).oper_status, 2)

    def test_a_recreated_agent_resending_its_queue_gets_duplicates(self):
        payload = poll(self.device)
        ingest(self.agent, [payload])
        self.agent.delete()
        new_agent, _token = make_agent("replacement")
        self.device.assigned_agent = new_agent
        self.device.save()
        result = ingest(new_agent, [payload])
        self.assertEqual((result.created, result.duplicates, result.rejected), (0, 1, 0))
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_the_same_poll_id_from_another_agent_or_device_is_a_conflict(self):
        payload = poll(self.device)
        ingest(self.agent, [payload])

        other_agent, _token = make_agent("other")
        other_device = make_device(other_agent, "other-dev")
        for agent, device in ((other_agent, other_device), (self.agent, make_device(self.agent, "same-agent-dev"))):
            with self.subTest(agent=agent.name):
                clash = poll(device, poll_id=payload["poll_id"], minutes=2)
                result = ingest(agent, [clash])
                self.assertEqual((result.status, result.created, result.duplicates), ("rejected", 0, 0))
                rejection = result.rejections[0]
                self.assertEqual(rejection.reason, "poll_id conflict")
                self.assertFalse(rejection.retryable)
        self.assertEqual(DevicePoll.objects.count(), 1)
        self.assertEqual(DevicePoll.objects.get().device, self.device)

    def test_a_different_poll_at_the_same_time_is_rejected_permanently(self):
        first = poll(self.device)
        ingest(self.agent, [first])
        clash = poll(self.device, measured_at=first["measured_at"])
        other = poll(self.device, minutes=3)
        result = ingest(self.agent, [clash, other])
        outcomes = self.outcomes(result)
        self.assertEqual(outcomes[other["poll_id"]]["result"], "created")
        rejected = outcomes[clash["poll_id"]]
        self.assertEqual(rejected["result"], "rejected")
        self.assertIn("a different poll is already stored for this device and time", rejected["reason"])
        self.assertFalse(rejected["retryable"])
        self.assertEqual(DevicePoll.objects.count(), 2)

    def test_a_reused_poll_id_with_another_time_is_a_conflict_not_a_duplicate(self):
        stored = poll(self.device, minutes=5)
        ingest(self.agent, [stored])
        reused = poll(self.device, minutes=4, poll_id=stored["poll_id"])
        result = ingest(self.agent, [reused])
        self.assertEqual((result.status, result.duplicates, result.created), ("rejected", 0, 0))
        self.assertEqual(result.rejections[0].reason, "poll_id conflict")
        self.assertFalse(result.rejections[0].retryable)
        self.assertEqual(DevicePoll.objects.get().measured_at, when(stored))  # data not silently dropped

    def test_a_race_after_the_precheck_gets_exact_results(self):
        stored = poll(self.device, minutes=5)
        ingest(self.agent, [stored])
        new = poll(self.device, minutes=4)
        # Simulate a concurrent report committing ``stored`` after the pre-check.
        with patch.object(reports, "_stored_polls", return_value={}):
            result = ingest(self.agent, [stored, new])
        outcomes = self.outcomes(result)
        self.assertEqual(outcomes[stored["poll_id"]]["result"], "duplicate")
        self.assertEqual(outcomes[new["poll_id"]]["result"], "created")
        self.assertEqual(DevicePoll.objects.count(), 2)
        self.assertEqual(InterfaceSample.objects.count(), 2)  # nothing written twice


class OutOfOrderTests(IngestTestCase):
    def test_late_polls_are_history_and_never_move_the_state_backwards(self):
        newest = poll(self.device, [interface(1, "Gi0/1", oper=2, speed=10_000_000_000)], minutes=2)
        late = poll(
            self.device,
            [interface(1, "OLD-NAME", oper=1, speed=1_000_000_000, alias="stale")],
            minutes=20,
            sys_uptime_ticks=111,
        )
        late["response_ms"] = 99.0
        late["system"] = {"name": "stale-name"}
        ingest(self.agent, [newest])
        result = ingest(self.agent, [late])
        self.assertEqual(result.created, 1)

        state = self.state()
        self.assertEqual(state.last_poll_at, when(newest))
        self.assertEqual((state.response_ms, state.sys_uptime_ticks, state.sys_name), (12.5, 8_123_456, "core-sw-1"))
        iface = self.interface(1)
        self.assertEqual((iface.name, iface.oper_status, iface.speed_bps, iface.alias), ("Gi0/1", 2, 10_000_000_000, ""))
        self.assertIsNone(iface.oper_status_changed_at)
        # The late poll's own samples are still history.
        self.assertEqual(InterfaceSample.objects.count(), 2)
        self.assertEqual(sorted(InterfaceSample.objects.values_list("oper_status", flat=True)), [1, 2])

    def test_delivery_order_does_not_change_the_final_state(self):
        polls = [
            poll(self.device, [interface(1, oper=1, speed=1_000_000_000)], minutes=30),
            poll(self.device, [interface(1, oper=2, speed=1_000_000_000)], minutes=20),
            poll(self.device, [interface(1, oper=1, speed=10_000_000_000)], minutes=10),
        ]
        snapshots = []
        for order in ((0, 1, 2), (2, 1, 0), (1, 2, 0), (2, 0, 1)):
            DevicePoll.objects.all().delete()
            InterfaceSample.objects.all().delete()
            Interface.objects.all().delete()
            DeviceSnmpState.objects.all().delete()
            for index in order:
                self.assertEqual(ingest(self.agent, [polls[index]]).created, 1)
            iface = self.interface(1)
            state = self.state()
            snapshots.append((iface.oper_status, iface.speed_bps, state.last_poll_at, state.last_success_at))
        self.assertEqual(len(set(snapshots)), 1, snapshots)
        self.assertEqual(snapshots[0][:2], (1, 10_000_000_000))

    def test_polls_in_one_report_are_applied_oldest_first(self):
        polls = [
            poll(self.device, [interface(1, oper=1)], minutes=3),
            poll(self.device, [interface(1, oper=2)], minutes=1),
            poll(self.device, [interface(1, oper=3)], minutes=2),
        ]
        ingest(self.agent, polls)  # listed newest-in-the-middle
        self.assertEqual(self.interface(1).oper_status, 2)
        self.assertEqual(self.state().last_poll_at, when(polls[1]))

    def test_last_success_is_the_newest_reachable_poll_even_if_delivered_late(self):
        down = poll(self.device, reachable=False, minutes=2)
        ingest(self.agent, [down])
        self.assertIsNone(self.state().last_success_at)
        early_success = poll(self.device, minutes=15)
        ingest(self.agent, [early_success])
        state = self.state()
        self.assertEqual(state.last_success_at, when(early_success))
        self.assertEqual((state.last_poll_at, state.reachable), (when(down), False))
        older_success = poll(self.device, minutes=30)
        ingest(self.agent, [older_success])
        self.assertEqual(self.state().last_success_at, when(early_success))  # never moves back


class FreshnessTests(IngestTestCase):
    """Reachability follows the newest poll; device data follows the newest reachable poll."""

    def test_a_newer_unreachable_poll_does_not_hide_newer_interface_data(self):
        ingest(self.agent, [poll(self.device, [interface(1, oper=1)], minutes=30)])
        ingest(self.agent, [poll(self.device, reachable=False, minutes=2)])
        down = DevicePoll.objects.get(reachable=False)
        late = poll(self.device, [interface(1, oper=2)], minutes=5, system={"name": "renamed"})
        ingest(self.agent, [late])

        # The -5 min poll is newer than any interface data stored (-30 min).
        self.assertEqual(self.interface(1).oper_status, 2)
        state = self.state()
        self.assertEqual(state.sys_name, "renamed")
        self.assertEqual(state.last_success_at, when(late))
        # ... while the device is still reported as it was seen last: unreachable.
        self.assertEqual(state.last_poll_at, down.measured_at)
        self.assertFalse(state.reachable)
        self.assertIsNone(state.sys_uptime_ticks)

    def test_the_final_state_is_the_same_whatever_the_delivery_order(self):
        polls = [
            poll(self.device, [interface(1, oper=1), interface(2, with_counters=False)], minutes=40, interfaces_complete=True),
            poll(self.device, reachable=False, minutes=30),
            poll(self.device, [interface(1, oper=2)], minutes=20),
            poll(self.device, [interface(1, oper=1), interface(2, with_counters=False)], minutes=10, interfaces_complete=True),
            poll(self.device, reachable=False, minutes=5),
        ]
        orders = [(0, 1, 2, 3, 4), (4, 3, 2, 1, 0), (2, 4, 0, 3, 1), (3, 0, 4, 2, 1), (1, 4, 3, 2, 0)]
        snapshots = set()
        for order in orders:
            for model in (InterfaceSample, DevicePoll, Interface, DeviceSnmpState):
                model.objects.all().delete()
            for index in order:
                ingest(self.agent, [polls[index]])
            state = self.state()
            snapshots.add(
                (
                    tuple(sorted(Interface.objects.values_list("if_index", "oper_status", "present"))),
                    state.last_poll_at,
                    state.last_success_at,
                    state.last_discovery_at,
                    state.reachable,
                    state.sys_name,
                )
            )
        self.assertEqual(len(snapshots), 1, snapshots)

    def test_delivering_all_polls_in_one_report_or_one_by_one_gives_the_same_state(self):
        polls = [
            poll(self.device, [interface(1, oper=1 + (m % 2))], minutes=m, interfaces_complete=(m % 3 == 0))
            for m in (9, 7, 5, 3, 1)
        ]
        ingest(self.agent, polls)
        together = (self.interface(1).oper_status, self.state().last_poll_at, self.state().last_discovery_at)
        for model in (InterfaceSample, DevicePoll, Interface, DeviceSnmpState):
            model.objects.all().delete()
        for item in polls:
            ingest(self.agent, [item])
        one_by_one = (self.interface(1).oper_status, self.state().last_poll_at, self.state().last_discovery_at)
        self.assertEqual(together, one_by_one)


class InterfaceLifecycleTests(IngestTestCase):
    def test_metadata_changes_are_applied_and_status_changes_are_timed(self):
        first = poll(self.device, [interface(1, "Gi0/1", oper=1, admin=1)], minutes=10)
        second = poll(self.device, [interface(1, "Uplink", oper=2, admin=2, alias="to dc2", speed=100_000_000)], minutes=5)
        ingest(self.agent, [first])
        self.assertIsNone(self.interface(1).oper_status_changed_at)
        ingest(self.agent, [second])
        iface = self.interface(1)
        self.assertEqual((iface.name, iface.alias, iface.speed_bps), ("Uplink", "to dc2", 100_000_000))
        self.assertEqual((iface.admin_status, iface.oper_status), (2, 2))
        self.assertEqual(iface.oper_status_changed_at, when(second))
        self.assertEqual(Interface.objects.count(), 1)

    def test_unchanged_interfaces_are_not_rewritten(self):
        ingest(self.agent, [poll(self.device, [interface(i) for i in range(1, 6)], minutes=10)])
        with CaptureQueriesContext(connection) as captured:
            ingest(self.agent, [poll(self.device, [interface(i) for i in range(1, 6)], minutes=5)])
        updates = [q["sql"] for q in captured if q["sql"].startswith('UPDATE "snmp_interface"')]
        self.assertEqual(updates, [])

    def test_only_changed_interfaces_are_updated(self):
        ingest(self.agent, [poll(self.device, [interface(i) for i in range(1, 6)], minutes=10)])
        entries = [interface(i, oper=2 if i == 3 else 1) for i in range(1, 6)]
        ingest(self.agent, [poll(self.device, entries, minutes=5)])
        self.assertEqual(
            dict(Interface.objects.values_list("if_index", "oper_status")),
            {1: 1, 2: 1, 3: 2, 4: 1, 5: 1},
        )

    def test_interfaces_missing_from_a_complete_poll_become_absent_and_return(self):
        listed = lambda *indexes: [interface(i, with_counters=False) for i in indexes]  # noqa: E731
        ingest(self.agent, [poll(self.device, listed(1, 2, 3), minutes=30, interfaces_complete=True)])
        self.assertTrue(all(i.present for i in Interface.objects.all()))

        ingest(self.agent, [poll(self.device, listed(1, 2), minutes=20, interfaces_complete=True)])
        self.assertEqual(dict(Interface.objects.values_list("if_index", "present")), {1: True, 2: True, 3: False})
        self.assertIsNotNone(self.state().last_discovery_at)

        # A partial poll that lists it again brings it back; one that does not never marks anything absent.
        ingest(self.agent, [poll(self.device, listed(1), minutes=15)])
        self.assertEqual(dict(Interface.objects.values_list("if_index", "present")), {1: True, 2: True, 3: False})
        ingest(self.agent, [poll(self.device, listed(3), minutes=10)])
        self.assertTrue(self.interface(3).present)

    def test_absence_follows_the_discovery_poll_not_its_delivery_order(self):
        late_listing = [interface(i, with_counters=False) for i in (1, 2, 3)]
        newer_listing = [interface(i, with_counters=False) for i in (1, 2)]
        newer = poll(self.device, newer_listing, minutes=5, interfaces_complete=True)
        older = poll(self.device, late_listing, minutes=20, interfaces_complete=True)
        ingest(self.agent, [newer])
        ingest(self.agent, [older])  # delivered late: interface 3 existed back then
        present = dict(Interface.objects.values_list("if_index", "present"))
        self.assertEqual(present[1], True)
        # The newer complete listing did not contain interface 3, so a late poll
        # that mentions it cannot make it present.
        self.assertEqual(present[3], False)
        self.assertEqual(self.state().last_discovery_at, when(newer))

    def test_a_complete_poll_only_affects_its_own_device(self):
        other = make_device(self.agent, "other-dev", management_address="192.0.2.50")
        ingest(self.agent, [poll(other, [interface(1, with_counters=False), interface(2, with_counters=False)], minutes=30)])
        ingest(self.agent, [poll(self.device, [interface(1, with_counters=False)], minutes=20, interfaces_complete=True)])
        self.assertTrue(all(i.present for i in Interface.objects.filter(device=other)))

    def test_interfaces_with_the_same_index_on_different_devices_are_distinct(self):
        other = make_device(self.agent, "other-dev", management_address="192.0.2.50")
        ingest(self.agent, [poll(self.device, [interface(1, "A")]), poll(other, [interface(1, "B")], minutes=2)])
        self.assertEqual(
            sorted(Interface.objects.values_list("device__name", "name")),
            [("core-sw", "A"), ("other-dev", "B")],
        )


class OwnershipUnderLockTests(IngestTestCase):
    """Ownership is re-checked after the device is locked, not only at validation."""

    def validated(self, *polls):
        return validate_snmp_payload(report(list(polls)), agent=self.agent)

    def test_a_device_reassigned_after_validation_is_not_written_to(self):
        validated = self.validated(poll(self.device))
        other_agent, _token = make_agent("other")
        self.device.assigned_agent = other_agent
        self.device.save()
        result = apply_snmp_report(self.agent, validated)
        self.assertEqual((result.status, result.created), ("rejected", 0))
        self.assertTrue(result.rejections[0].retryable)  # it may be assigned back
        self.assertEqual(result.rejections[0].reason, "unknown device_id or device not assigned to this agent")
        for model in (DevicePoll, Interface, InterfaceSample):
            self.assertFalse(model.objects.exists(), model.__name__)

    def test_a_device_disabled_after_validation_is_not_written_to(self):
        validated = self.validated(poll(self.device))
        self.device.enabled = False
        self.device.save()
        result = apply_snmp_report(self.agent, validated)
        self.assertEqual(result.rejections[0].reason, REASON_DEVICE_DISABLED)
        self.assertTrue(result.rejections[0].retryable)
        self.assertFalse(DevicePoll.objects.exists())

    def test_a_device_deleted_after_validation_is_rejected_not_an_error(self):
        spare = make_device(self.agent, "spare", management_address="192.0.2.90")
        validated = self.validated(poll(spare), poll(self.device, minutes=2))
        spare.delete()
        result = apply_snmp_report(self.agent, validated)
        self.assertEqual((result.status, result.created, result.rejected), ("partial", 1, 1))
        self.assertTrue(result.rejections[0].retryable)

    def test_only_the_affected_devices_polls_are_rejected(self):
        other = make_device(self.agent, "other-dev", management_address="192.0.2.91")
        validated = self.validated(poll(self.device, minutes=3), poll(other, minutes=2))
        other.enabled = False
        other.save()
        result = apply_snmp_report(self.agent, validated)
        self.assertEqual((result.created, result.rejected), (1, 1))
        self.assertEqual(DevicePoll.objects.get().device, self.device)

    def test_a_poll_for_a_device_that_was_not_ready_is_accepted_when_resent_later(self):
        # An operator creates the device and its SNMP settings after the agent
        # has started polling it: the agent keeps the poll and resends it.
        from apps.snmp.models import SnmpConfig

        late = make_device(self.agent, "late-setup", configured=False, management_address="192.0.2.92")
        payload = poll(late)
        first = ingest(self.agent, [payload])
        self.assertEqual(first.accepted, 0)
        self.assertTrue(first.rejections[0].retryable)
        SnmpConfig.objects.create(device=late, credential_profile="core")
        second = ingest(self.agent, [payload])
        self.assertEqual((second.status, second.created), ("accepted", 1))


class OwnershipTests(IngestTestCase):
    def test_polls_for_devices_of_other_agents_are_rejected_and_nothing_is_stored(self):
        other_agent, _token = make_agent("other")
        foreign = make_device(other_agent, "foreign", management_address="192.0.2.77")
        payload = poll(foreign)
        result = ingest(self.agent, [payload])
        self.assertEqual((result.status, result.created, result.accepted), ("rejected", 0, 0))
        self.assertEqual(result.rejections[0].reason, "unknown device_id or device not assigned to this agent")
        # The device may be assigned to this agent later: do not drop the poll.
        self.assertTrue(result.rejections[0].retryable)
        for model in (DevicePoll, Interface, InterfaceSample, DeviceSnmpState):
            self.assertFalse(model.objects.exists(), model.__name__)

    def test_reports_mixing_valid_and_invalid_polls_are_partial(self):
        other_agent, _token = make_agent("other")
        foreign = make_device(other_agent, "foreign", management_address="192.0.2.77")
        good = poll(self.device, minutes=3)
        bad_device = poll(foreign, minutes=2)
        bad_value = poll(self.device, minutes=1, reachable="maybe")
        result = ingest(self.agent, [good, bad_device, bad_value])
        self.assertEqual((result.status, result.created, result.rejected), ("partial", 1, 2))
        outcomes = self.outcomes(result)
        self.assertEqual(outcomes[good["poll_id"]]["result"], "created")
        self.assertEqual(outcomes[bad_device["poll_id"]]["result"], "rejected")
        self.assertEqual(outcomes[bad_value["poll_id"]]["result"], "rejected")
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_a_device_reassigned_to_another_agent_stops_accepting_the_old_one(self):
        other_agent, _token = make_agent("other")
        self.device.assigned_agent = other_agent
        self.device.save()
        result = ingest(self.agent, [poll(self.device)])
        self.assertEqual(result.accepted, 0)
        self.assertEqual(ingest(other_agent, [poll(self.device)]).created, 1)


class AllOrNothingTests(IngestTestCase):
    """A poll is stored completely or not at all; failures never acknowledge."""

    def assert_no_state_written(self, device=None):
        """State rows are created empty under the lock; no poll data may be in them."""
        queryset = DeviceSnmpState.objects.filter(last_poll_at__isnull=False)
        if device is not None:
            queryset = queryset.filter(pk=device.pk)
        self.assertFalse(queryset.exists())

    def assert_nothing_stored(self, device=None):
        for model in (DevicePoll, Interface, InterfaceSample):
            queryset = model.objects.all()
            if device is not None:
                queryset = queryset.filter(**{"interface__device" if model is InterfaceSample else "device": device})
            self.assertFalse(queryset.exists(), model.__name__)

    def test_a_failure_while_storing_samples_rolls_back_the_whole_poll(self):
        payload = poll(self.device)
        with patch.object(InterfaceSample.objects, "bulk_create", side_effect=IntegrityError("boom")):
            result = ingest(self.agent, [payload])
        self.assertEqual((result.status, result.created, result.accepted), ("rejected", 0, 0))
        rejection = result.rejections[0]
        self.assertEqual((rejection.reason, rejection.retryable), ("poll could not be stored", True))
        self.assert_nothing_stored()
        self.assert_no_state_written()
        # The agent resends: the poll is then stored normally.
        self.assertEqual(ingest(self.agent, [payload]).created, 1)

    def test_one_failing_poll_does_not_affect_the_others_in_the_report(self):
        second = make_device(self.agent, "edge-rtr", management_address="192.0.2.11")
        good = poll(self.device, [interface(1), interface(2)])
        doomed = poll(second, [interface(10)], minutes=2)
        original = InterfaceSample.objects.bulk_create

        def fail_for_second_device(objs, **kwargs):
            if any(sample.interface.device_id == second.pk for sample in objs):
                raise IntegrityError("simulated failure")
            return original(objs, **kwargs)

        with patch.object(InterfaceSample.objects, "bulk_create", side_effect=fail_for_second_device):
            result = ingest(self.agent, [good, doomed])

        outcomes = self.outcomes(result)
        self.assertEqual(outcomes[good["poll_id"]]["result"], "created")
        self.assertEqual((outcomes[doomed["poll_id"]]["result"], outcomes[doomed["poll_id"]]["retryable"]), ("rejected", True))
        self.assertEqual(result.status, "partial")
        # The good poll is complete ...
        self.assertEqual(DevicePoll.objects.filter(device=self.device).count(), 1)
        self.assertEqual(InterfaceSample.objects.filter(interface__device=self.device).count(), 2)
        self.assertTrue(DeviceSnmpState.objects.filter(pk=self.device.pk, last_poll_at__isnull=False).exists())
        # ... and the failed one left no trace at all.
        self.assert_nothing_stored(second)
        self.assert_no_state_written(second)

    def test_a_failure_cannot_leave_history_behind_that_the_state_does_not_know(self):
        payload = poll(self.device)
        with patch.object(DeviceSnmpState.objects, "bulk_update", side_effect=IntegrityError("boom")):
            result = ingest(self.agent, [payload])
        self.assertEqual(result.created, 0)
        self.assert_nothing_stored()

    def test_a_database_outage_propagates_instead_of_acknowledging(self):
        validated = validate_snmp_payload(report([poll(self.device)]), agent=self.agent)
        with patch.object(DevicePoll.objects, "bulk_create", side_effect=OperationalError("down")):
            with self.assertRaises(OperationalError):
                apply_snmp_report(self.agent, validated)
        self.assert_nothing_stored()

    def test_a_late_database_failure_rolls_back_everything(self):
        validated = validate_snmp_payload(report([poll(self.device)]), agent=self.agent)
        with patch.object(Interface.objects, "bulk_create", side_effect=OperationalError("down")):
            with self.assertRaises(OperationalError):
                apply_snmp_report(self.agent, validated)
        self.assert_nothing_stored()
        self.assert_no_state_written()


class QueryCountTests(IngestTestCase):
    """Ingestion issues a fixed number of queries however much a report carries."""

    MAX_QUERIES = 17

    def make_polls(self, devices, polls_each, interfaces, offset=0):
        return [
            poll(device, [interface(i) for i in range(1, interfaces + 1)], minutes=offset + 1 + n)
            for device in devices
            for n in range(polls_each)
        ]

    def count(self, polls):
        validated = validate_snmp_payload(report(polls), agent=self.agent)
        with CaptureQueriesContext(connection) as captured:
            result = apply_snmp_report(self.agent, validated)
        self.assertEqual(result.created, len(polls))
        return len(captured)

    def test_first_report_costs_the_same_for_one_poll_and_for_hundreds_of_rows(self):
        small_devices = [make_device(self.agent, "small", management_address="192.0.2.21")]
        large_devices = [make_device(self.agent, f"large-{i}", management_address=f"192.0.2.{100 + i}") for i in range(10)]
        small = self.count(self.make_polls(small_devices, 1, 2))
        large = self.count(self.make_polls(large_devices, 2, 24))  # 20 polls, 480 samples
        self.assertEqual(large, small)
        self.assertLessEqual(large, self.MAX_QUERIES)

    def test_steady_state_reports_are_cheaper_and_equally_flat(self):
        devices = [make_device(self.agent, f"d-{i}", management_address=f"192.0.2.{100 + i}") for i in range(10)]
        self.count(self.make_polls(devices, 1, 24, offset=10))
        again = self.count(self.make_polls(devices, 2, 24, offset=0))
        # Newer than every state written above, like the polls it is compared with.
        single = self.count(self.make_polls(devices[:1], 1, 24, offset=-0.5))
        self.assertEqual(again, single)
        self.assertLessEqual(again, self.MAX_QUERIES - 3)

    def test_rows_are_inserted_in_bulk(self):
        devices = [make_device(self.agent, f"b-{i}", management_address=f"192.0.2.{100 + i}") for i in range(5)]
        validated = validate_snmp_payload(report(self.make_polls(devices, 2, 24)), agent=self.agent)
        with CaptureQueriesContext(connection) as captured:
            apply_snmp_report(self.agent, validated)
        inserts = [q["sql"] for q in captured if q["sql"].startswith("INSERT")]
        tables = [sql.split('"')[1] for sql in inserts]
        self.assertEqual(tables.count("snmp_interfacesample"), 1)
        self.assertEqual(tables.count("snmp_devicepoll"), 1)
        self.assertEqual(InterfaceSample.objects.count(), 5 * 2 * 24)


class ConcurrentReportTests(TransactionTestCase):
    def run_threads(self, work, count):
        barrier = threading.Barrier(count)
        outcomes, errors = [], []

        def worker(index):
            try:
                barrier.wait(timeout=10)
                outcomes.append(work(index))
            except Exception as exc:  # noqa: BLE001 - surfaced via assertion
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertEqual(errors, [])
        self.assertEqual(len(outcomes), count)
        return outcomes

    def test_the_same_polls_reported_concurrently_are_stored_once(self):
        agent, _token = make_agent("race")
        device = make_device(agent)
        polls = [poll(device, [interface(i) for i in range(1, 5)], minutes=m) for m in range(1, 11)]

        results = self.run_threads(lambda _i: ingest(agent, polls), 3)

        self.assertEqual(sum(r.created for r in results), 10)
        self.assertEqual(sum(r.duplicates for r in results), 20)
        self.assertEqual(sum(r.rejected for r in results), 0)
        for result in results:
            self.assertEqual(result.status, "accepted")
        self.assertEqual(DevicePoll.objects.count(), 10)
        self.assertEqual(InterfaceSample.objects.count(), 40)
        self.assertEqual(Interface.objects.count(), 4)
        self.assertEqual(DeviceSnmpState.objects.get().last_poll_at, when(polls[0]))

    def test_different_polls_of_one_device_reported_concurrently_all_land_and_state_is_newest(self):
        agent, _token = make_agent("race2")
        device = make_device(agent)
        batches = [
            [poll(device, [interface(1, oper=1 + (m % 2)), interface(2)], minutes=m + b * 10) for m in range(1, 6)]
            for b in range(4)
        ]
        newest = min((p for batch in batches for p in batch), key=lambda p: -when(p).timestamp())

        results = self.run_threads(lambda i: ingest(agent, batches[i]), 4)

        self.assertEqual(sum(r.created for r in results), 20)
        self.assertEqual(DevicePoll.objects.count(), 20)
        self.assertEqual(InterfaceSample.objects.count(), 40)
        state = DeviceSnmpState.objects.get()
        self.assertEqual(state.last_poll_at, when(newest))
        interface_one = Interface.objects.get(if_index=1)
        newest_oper = [e for e in newest["interfaces"] if e["if_index"] == 1][0]["oper_status"]
        self.assertEqual(interface_one.oper_status, newest_oper)

    def test_first_reports_for_several_new_devices_in_opposite_orders_do_not_deadlock(self):
        # Creating the state rows of devices that have never been polled in a
        # different order than a concurrent report deadlocks.
        agent, _token = make_agent("race3")
        devices = [make_device(agent, f"new-{i}", management_address=f"192.0.2.{(i % 200) + 10}") for i in range(40)]
        forward = [poll(d, [interface(1)], minutes=3) for d in devices]
        backward = [poll(d, [interface(1)], minutes=2) for d in reversed(devices)]

        results = self.run_threads(lambda i: ingest(agent, forward if i == 0 else backward), 2)

        self.assertEqual(sum(r.created for r in results), 80)
        self.assertEqual(DevicePoll.objects.count(), 80)
        self.assertEqual(DeviceSnmpState.objects.count(), 40)

    def test_overlapping_reports_that_fall_back_to_per_poll_storage_do_not_deadlock(self):
        # Regression: after a failed batch the per-poll fallback used to re-lock the
        # device states one at a time in report order, while concurrent reports
        # locked them in primary-key order: "deadlock detected" (HTTP 500).
        agent, _token = make_agent("race4")
        devices = [make_device(agent, f"d{i}", management_address=f"192.0.2.{50 + i}") for i in range(4)]
        for device in devices:  # the state rows exist: lock *order* is what matters
            ingest(agent, [poll(device, [interface(1)], minutes=500)])
        polls = [poll(d, [interface(1)], minutes=m) for d in devices for m in range(1, 31)]
        original = DevicePoll.objects.bulk_create

        def fail_whole_batches(objs, **kwargs):
            if len(objs) > 1:
                raise IntegrityError("force the per-poll fallback")
            return original(objs, **kwargs)

        def work(index):
            chunk = random.Random(index).sample(polls, 40)
            random.Random(index + 100).shuffle(chunk)
            return ingest(agent, chunk)

        with patch.object(DevicePoll.objects, "bulk_create", side_effect=fail_whole_batches):
            results = self.run_threads(work, 6)

        # Every poll any worker asked for is stored exactly once; overlaps are duplicates.
        asked_for = set()
        total_asked = 0
        for index in range(6):
            chunk = random.Random(index).sample(polls, 40)
            asked_for |= {item["poll_id"] for item in chunk}
            total_asked += len(chunk)
        stored_ids = {str(pk) for pk in DevicePoll.objects.values_list("pk", flat=True)}
        self.assertTrue(asked_for <= stored_ids)
        self.assertEqual(sum(r.created for r in results), len(asked_for))
        self.assertEqual(sum(r.created + r.duplicates for r in results), total_asked)
        self.assertEqual(sum(r.rejected for r in results), 0)
