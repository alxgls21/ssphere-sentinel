"""The agent's SNMP collector against the real server ingest.

The polls are built by the agent's own code (``DevicePoller`` fed with scripted
device data), queued and batched by its queue and delivery classes, posted to
the real heartbeat endpoint, and the real response is fed back to the agent's
acknowledgement handling. Whatever the two sides disagree about shows up here:
a field the server rejects, a batch larger than it accepts, a delta state it
does not know, an acknowledgement the agent cannot read.

(The agent never imports Django, and these tests only import the agent's
SNMP modules, which need nothing but the standard library.)
"""

import json
from datetime import datetime, timedelta, timezone

from django.test import Client, TestCase
from django.urls import reverse

from agent.measurement_queue import MeasurementQueue
from agent.snmp_collector import DevicePoller
from agent.snmp_delivery import SnmpDelivery
from agent.snmp_payload import ERROR_CATEGORIES, MAX_INTERFACES_PER_REPORT, MAX_POLLS_PER_REPORT
from agent.tests import snmp_helpers as fake
from apps.snmp.models import DevicePoll, DeviceSnmpState, Interface, InterfaceSample
from apps.snmp.tests.helpers import make_agent, make_device


class AgentContractTestCase(TestCase):
    def setUp(self):
        self.client = Client(raise_request_exception=False)
        self.agent, self.token = make_agent()
        self.device = make_device(self.agent)
        self.clock = fake.Clock()
        # The server accepts polls up to 8 days old and 5 minutes ahead.
        self.clock.wall = datetime.now(timezone.utc) - timedelta(hours=3)
        self.queue_clock = fake.Clock(1_000_000.0)
        self.queue = MeasurementQueue(None, wall_fn=self.queue_clock.monotonic)
        self.addCleanup(self.queue.close)
        self.delivery = SnmpDelivery(self.queue)
        self.fetcher = fake.FakeFetcher()
        self.poller = self.make_poller(fake.v3())

    def make_poller(self, credential, **device_overrides):
        return DevicePoller(
            fake.device(id=self.device.pk, poll_interval_seconds=300, **device_overrides),
            credential,
            self.fetcher,
            monotonic=self.clock.monotonic,
            utcnow=self.clock.utcnow,
        )

    def poll(self, data, *, advance=300, poller=None):
        """Build one poll from scripted device data and queue it."""
        self.fetcher.push(data)
        self.clock.advance(advance)
        poll = (poller or self.poller).poll()
        self.queue.enqueue_snmp(poll)
        return poll

    def deliver(self):
        """One heartbeat carrying whatever the agent would send now."""
        batch = self.delivery.prepare_batch()
        body = json.dumps({"snmp": batch.section()})
        response = self.client.post(
            reverse("agent-heartbeat"),
            data=body,
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.token}",
        )
        self.assertEqual(response.status_code, 200)
        ack = self.delivery.acknowledge(batch, response.content.decode())
        return batch, response.json(), ack, body


def two_interfaces(**first):
    return {1: fake.interface(1, **first), 2: fake.interface(2, oper=2)}


class AcceptanceTests(AgentContractTestCase):
    def test_a_discovery_poll_is_accepted_stored_and_acknowledged(self):
        poll = self.poll(
            fake.raw_data(
                {
                    1: fake.interface(1, alias="uplink to dc2"),
                    2: fake.interface(2, oper=2, high_speed=10_000),
                    3: fake.interface(3, name="Loopback0", descr="Loopback0", type=24),
                },
                discover=True,
            )
        )
        batch, data, ack, _body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_created"], data["snmp_rejected"]), ("accepted", 1, 0))
        self.assertFalse(ack.is_batch_failure)
        self.assertEqual(ack.stored, {poll["poll_id"]})
        self.assertEqual(self.queue.snmp_count(), 0)

        stored = DevicePoll.objects.get()
        self.assertEqual((stored.reachable, stored.sys_uptime_ticks), (True, 1_000_000))
        state = DeviceSnmpState.objects.get(pk=self.device.pk)
        self.assertEqual((state.sys_name, state.sys_object_id), ("core-sw-1", "1.3.6.1.4.1.9.1.2504"))
        self.assertIsNotNone(state.last_discovery_at)
        interfaces = {i.if_index: i for i in Interface.objects.filter(device=self.device)}
        self.assertEqual(sorted(interfaces), [1, 2, 3])
        self.assertEqual((interfaces[1].name, interfaces[1].alias, interfaces[1].speed_bps), ("Gi0/1", "uplink to dc2", 1_000_000_000))
        self.assertEqual(interfaces[2].speed_bps, 10_000_000_000)
        self.assertEqual(interfaces[3].if_type, 24)
        # The loopback is listed (inventory) but not monitored: no sample.
        self.assertEqual(sorted(InterfaceSample.objects.values_list("interface__if_index", flat=True)), [1, 2])
        self.assertEqual(InterfaceSample.objects.get(interface__if_index=1).delta_state, "first")

    def test_a_regular_poll_keeps_names_and_a_complete_discovery_marks_vanished_interfaces_absent(self):
        self.poll(fake.raw_data(two_interfaces(), discover=True))
        self.deliver()
        self.poll(fake.raw_data(two_interfaces()))
        self.deliver()
        self.assertEqual(
            sorted(Interface.objects.filter(present=True).values_list("name", flat=True)), ["Gi0/1", "Gi0/2"]
        )
        # Interface 2 disappears: the agent notices, rediscovers and lists everything that is left.
        self.poll(fake.raw_data({1: fake.interface(1)}))
        self.poll(fake.raw_data({1: fake.interface(1)}, discover=True))
        batch, data, _ack, _body = self.deliver()
        self.assertEqual(data["snmp_created"], 2)
        self.assertTrue(batch.polls[-1]["interfaces_complete"])
        self.assertEqual(list(Interface.objects.filter(present=False).values_list("if_index", flat=True)), [2])

    def test_every_delta_state_the_agent_can_produce_is_accepted_and_stored_as_sent(self):
        self.poll(fake.raw_data(two_interfaces(in_octets64=10_000), discover=True))
        self.deliver()
        steps = [
            # (device data, expected delta_state, expected in_octets delta)
            (fake.raw_data(two_interfaces(in_octets64=13_000), uptime=1_030_000), "ok", 3_000),
            (fake.raw_data(two_interfaces(in_octets64=13_500, high_speed=100), uptime=1_060_000), "speed_changed", 500),
            (fake.raw_data(two_interfaces(in_octets64=20), uptime=1_090_000), "reset", None),
            (fake.raw_data(two_interfaces(in_octets64=40), uptime=500), "reboot", None),
        ]
        for data, state, delta in steps:
            with self.subTest(state):
                self.poll(data)
                _batch, response, _ack, _body = self.deliver()
                self.assertEqual((response["snmp"], response["snmp_rejected"]), ("accepted", 0))
                sample = InterfaceSample.objects.filter(interface__if_index=1).latest("measured_at")
                self.assertEqual(sample.delta_state, state)
                self.assertEqual(sample.in_octets_delta, delta)
                self.assertEqual(sample.interval_seconds, 300.0)
                self.assertEqual(sample.octets_bits, 64)
        with self.subTest("gap"):
            # A long silence between two polls.
            self.poll(fake.raw_data(two_interfaces(in_octets64=100), uptime=40_000), advance=3_000)
            self.deliver()
            sample = InterfaceSample.objects.filter(interface__if_index=1).latest("measured_at")
            self.assertEqual((sample.delta_state, sample.in_octets_delta), ("gap", None))
        self.assertEqual(self.queue.snmp_count(), 0)

    def test_32_bit_counters_including_a_wrap_are_accepted(self):
        old = {1: fake.interface(1, in_octets64=None, out_octets64=None, in_octets32=4_294_967_000, out_octets32=10)}
        new = {1: fake.interface(1, in_octets64=None, out_octets64=None, in_octets32=700, out_octets32=60)}
        self.poll(fake.raw_data(old, discover=True))
        self.deliver()
        self.poll(fake.raw_data(new, uptime=1_030_000))
        _batch, data, _ack, _body = self.deliver()
        self.assertEqual(data["snmp"], "accepted")
        sample = InterfaceSample.objects.get(delta_state="ok")
        self.assertEqual((sample.octets_bits, sample.in_octets, sample.in_octets_delta), (32, 700, 996))
        self.assertEqual(sample.out_octets_delta, 50)

    def test_unreachable_polls_of_every_error_category_are_accepted(self):
        for category in sorted(ERROR_CATEGORIES):
            with self.subTest(category):
                self.fetcher.push(fake.unreachable(category))
                self.clock.advance(60)
                with self.assertLogs("sentinel_agent", level="DEBUG"):
                    poll = self.poller.poll()
                self.queue.enqueue_snmp(poll)
                _batch, data, _ack, _body = self.deliver()
                self.assertEqual((data["snmp"], data["snmp_rejected"]), ("accepted", 0))
                self.assertEqual(DevicePoll.objects.get(pk=poll["poll_id"]).error, category)
        state = DeviceSnmpState.objects.get(pk=self.device.pk)
        self.assertFalse(state.reachable)

    def test_a_discovery_poll_with_the_servers_maximum_of_512_interfaces(self):
        table = {i: fake.interface(i) for i in range(1, 513)}
        poller = self.make_poller(fake.v3(), interfaces=fake.selection(max_interfaces=512))
        poll = self.poll(fake.raw_data(table, discover=True), poller=poller)
        self.assertEqual(len(poll["interfaces"]), 512)
        _batch, data, _ack, _body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_created"]), ("accepted", 1))
        self.assertEqual(Interface.objects.filter(device=self.device).count(), 512)
        self.assertEqual(InterfaceSample.objects.count(), 512)

    def test_the_first_poll_after_a_week_long_outage_is_accepted(self):
        for label, uptime, state in (("gap", 1_300_000, "gap"), ("reboot", 400, "reboot")):
            with self.subTest(label):
                self.poll(fake.raw_data(two_interfaces(in_octets64=10_000), discover=True))
                self.deliver()
                self.clock.now += 8 * 24 * 3600  # the device was silent for 8 days (monotonic time only)
                self.poll(fake.raw_data(two_interfaces(in_octets64=20_000 if state == "gap" else 5), uptime=uptime))
                _batch, data, ack, _body = self.deliver()
                self.assertEqual((data["snmp"], data["snmp_rejected"]), ("accepted", 0), data)
                sample = InterfaceSample.objects.filter(interface__if_index=1).latest("measured_at")
                self.assertEqual(sample.delta_state, state)
                self.assertIsNone(sample.interval_seconds)  # too long to be a valid interval: left out
                self.assertEqual(self.queue.snmp_count(), 0)

    def test_busy_32_bit_link_wraps_are_stored_as_deltas(self):
        speed = {"high_speed": None, "speed": 100_000_000}
        before = {1: fake.interface(1, in_octets64=None, out_octets64=None, in_octets32=4_294_967_296 - 1_000_000_000, out_octets32=0, **speed)}
        after = {1: fake.interface(1, in_octets64=None, out_octets64=None, in_octets32=1_600_000_000, out_octets32=10, **speed)}
        self.poll(fake.raw_data(before, discover=True))
        self.deliver()
        self.poll(fake.raw_data(after, uptime=1_030_000))
        _batch, data, _ack, _body = self.deliver()
        self.assertEqual(data["snmp"], "accepted")
        sample = InterfaceSample.objects.get(delta_state="ok")
        self.assertEqual((sample.octets_bits, sample.in_octets_delta), (32, 2_600_000_000))

    def test_values_a_buggy_device_may_report_never_cost_a_poll(self):
        table = {
            0: fake.interface(0),
            1: fake.interface(1),
            2**31: fake.interface(2**31),
        }
        self.poll(
            fake.raw_data(
                table,
                discover=True,
                uptime=-5,
                system={"name": "sw", "descr": "d", "object_id": "enterprises.9.1"},
            )
        )
        _batch, data, _ack, _body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_rejected"]), ("accepted", 0), data)
        self.assertEqual(list(Interface.objects.values_list("if_index", flat=True)), [1])
        self.assertEqual(DeviceSnmpState.objects.get(pk=self.device.pk).sys_object_id, "")

    def test_512_interfaces_of_worst_case_text_are_accepted(self):
        text = "日本語" * 100
        table = {i: fake.interface(i, name=text, descr=text, alias=text) for i in range(1, 513)}
        poller = self.make_poller(fake.v3(), interfaces=fake.selection(max_interfaces=512))
        self.poll(fake.raw_data(table, discover=True), poller=poller)
        _batch, data, _ack, body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_created"]), ("accepted", 1))
        self.assertLess(len(body), 2_000_000)  # the heartbeat body stays below Django's 2.5 MiB default
        self.assertEqual(Interface.objects.get(if_index=1).name, text[:128])

    def test_odd_device_text_never_costs_a_poll(self):
        table = {
            1: fake.interface(1, name="Gi0/1\x00\x1b[31m", descr="x" * 400, alias="línea ünïcode 日本語\n\t"),
            2: fake.interface(2, name="", descr=""),
        }
        self.poll(fake.raw_data(table, discover=True, system={"name": "sw\n1", "descr": "d" * 5000, "object_id": "1.3.6.1.4.1.9"}))
        _batch, data, _ack, _body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_rejected"]), ("accepted", 0))
        self.assertEqual(Interface.objects.get(if_index=2).name, "if2")


class DeliveryTests(AgentContractTestCase):
    def test_batches_never_exceed_what_the_server_accepts(self):
        self.poll(fake.raw_data({i: fake.interface(i) for i in range(1, 41)}, discover=True))
        for step in range(1, 121):
            self.poll(
                fake.raw_data(
                    {i: fake.interface(i, in_octets64=1000 + step * 10) for i in range(1, 41)},
                    uptime=1_000_000 + step * 100,
                ),
                advance=1,
            )
        self.assertEqual(self.queue.snmp_count(), 121)
        batches = 0
        while self.queue.snmp_count():
            before = self.queue.snmp_count()
            batch, data, _ack, body = self.deliver()
            batches += 1
            self.assertLessEqual(len(batch.polls), MAX_POLLS_PER_REPORT)
            self.assertLessEqual(sum(len(p["interfaces"]) for p in batch.polls), MAX_INTERFACES_PER_REPORT)
            self.assertLess(len(body), 1_000_000)
            self.assertEqual((data["snmp"], data["snmp_rejected"]), ("accepted", 0))
            self.assertEqual(self.queue.snmp_count(), before - len(batch.polls))
        self.assertGreaterEqual(batches, 3)
        self.assertEqual(DevicePoll.objects.count(), 121)
        self.assertEqual(InterfaceSample.objects.count(), 121 * 40)

    def test_a_resent_batch_is_acknowledged_as_duplicates_and_leaves_the_queue(self):
        self.poll(fake.raw_data(two_interfaces(), discover=True))
        lost = self.delivery.prepare_batch()
        self.client.post(
            reverse("agent-heartbeat"),
            data=json.dumps({"snmp": lost.section()}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.token}",
        )  # stored by the server, but the response never reached the agent
        self.assertEqual(self.queue.snmp_count(), 1)
        _batch, data, ack, _body = self.deliver()
        self.assertEqual((data["snmp_created"], data["snmp_duplicates"]), (0, 1))
        self.assertEqual(ack.stored, {lost.polls[0]["poll_id"]})
        self.assertEqual(self.queue.snmp_count(), 0)
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_a_poll_the_server_cannot_accept_yet_stays_queued_and_succeeds_later(self):
        other, _token = make_agent("other-poller")
        self.device.assigned_agent = other
        self.device.save()
        poll = self.poll(fake.raw_data(two_interfaces(), discover=True))
        with self.assertLogs("sentinel_agent", level="WARNING"):
            _batch, data, ack, _body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_rejected"]), ("rejected", 1))
        self.assertEqual(ack.retryable, {poll["poll_id"]: "unknown device_id or device not assigned to this agent"})
        self.assertEqual(self.queue.snmp_count(), 1)
        self.assertFalse(DevicePoll.objects.exists())

        self.device.assigned_agent = self.agent  # an operator fixes it
        self.device.save()
        self.queue_clock.advance(60)  # past the retry delay
        _batch, data, ack, _body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_created"]), ("accepted", 1))
        self.assertEqual(self.queue.snmp_count(), 0)
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_a_device_without_snmp_configuration_is_retried_not_dropped(self):
        self.device.snmp_config.delete()
        self.poll(fake.raw_data(two_interfaces(), discover=True))
        with self.assertLogs("sentinel_agent", level="WARNING"):
            _batch, _data, ack, _body = self.deliver()
        self.assertEqual(list(ack.retryable.values()), ["device has no SNMP configuration"])
        self.assertEqual(self.queue.snmp_count(), 1)

    def test_a_poll_the_server_rejects_for_good_is_dropped(self):
        poll = self.poll(fake.raw_data(two_interfaces(), discover=True))
        # Corrupt the stored copy the way a bug on the agent could: the server
        # says "never", and the agent must not keep resending it.
        stored = self.queue._conn.execute("SELECT payload FROM pending_snmp").fetchone()[0]
        broken = json.loads(stored)
        broken["reachable"] = "maybe"
        self.queue._conn.execute("UPDATE pending_snmp SET payload = ?", (json.dumps(broken),))
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            _batch, data, ack, _body = self.deliver()
        self.assertEqual((data["snmp"], data["snmp_rejected"]), ("rejected", 1))
        self.assertEqual(list(ack.permanent), [poll["poll_id"]])
        self.assertEqual(self.queue.snmp_count(), 0)
        self.assertIn("permanently rejected", "\n".join(logs.output))

    def test_secrets_never_reach_the_server(self):
        credential = fake.v3()
        poller = self.make_poller(credential)
        self.poll(fake.raw_data(two_interfaces(), discover=True), poller=poller)
        _batch, data, _ack, body = self.deliver()
        self.assertNotIn(fake.SECRET, body)
        self.assertNotIn(fake.SECRET, json.dumps(data))
        for model in (DevicePoll, DeviceSnmpState, Interface, InterfaceSample):
            for row in model.objects.values():
                self.assertNotIn(fake.SECRET, repr(row))
