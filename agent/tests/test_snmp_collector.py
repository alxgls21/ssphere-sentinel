import json
import threading
import unittest

from agent.snmp_collector import DevicePoller, select_interfaces
from agent.snmp_fetch import SnmpFetchCancelled
from agent.snmp_payload import sanitize_poll
from agent.tests.snmp_helpers import (
    SECRET,
    Clock,
    FakeFetcher,
    community,
    device,
    ids,
    interface,
    raw_data,
    selection,
    unreachable,
    v3,
)


def make_poller(fetcher, clock, *, dev=None, credential=None):
    return DevicePoller(
        dev or device(),
        credential or v3(),
        fetcher,
        monotonic=clock.monotonic,
        utcnow=clock.utcnow,
        new_id=ids(),
    )


def entries(poll):
    return {entry["if_index"]: entry for entry in poll["interfaces"]}


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.fetcher = FakeFetcher(
            raw_data(
                {1: interface(1, alias="uplink"), 2: interface(2, oper=2)},
                discover=True,
            )
        )
        self.poller = make_poller(self.fetcher, self.clock)

    def test_the_first_poll_is_a_discovery_poll(self):
        poll = self.poller.poll()
        self.assertTrue(self.fetcher.plans[0].discover)
        self.assertTrue(poll["reachable"])
        self.assertTrue(poll["interfaces_complete"])
        self.assertEqual(poll["system"], {"name": "core-sw-1", "descr": "Cisco IOS XE", "object_id": "1.3.6.1.4.1.9.1.2504"})
        self.assertEqual(poll["sys_uptime_ticks"], 1_000_000)
        self.assertEqual(poll["response_ms"], 12.5)
        self.assertEqual(poll["measured_at"], "2026-10-12T14:00:00+00:00")

    def test_interfaces_carry_descriptive_and_status_fields(self):
        poll = self.poller.poll()
        one = entries(poll)[1]
        self.assertEqual(
            {k: v for k, v in one.items() if k != "counters"},
            {
                "if_index": 1,
                "name": "Gi0/1",
                "descr": "GigabitEthernet0/1",
                "alias": "uplink",
                "if_type": 6,
                "speed_bps": 1_000_000_000,
                "admin_status": 1,
                "oper_status": 1,
            },
        )
        self.assertEqual(entries(poll)[2]["oper_status"], 2)

    def test_the_first_sample_has_raw_counters_and_no_deltas(self):
        counters = entries(self.poller.poll())[1]["counters"]
        self.assertEqual(counters["octets_bits"], 64)
        self.assertEqual(counters["delta_state"], "first")
        self.assertNotIn("delta", counters)
        self.assertNotIn("interval_seconds", counters)
        self.assertEqual(
            counters["raw"],
            {"in_octets": 1000, "out_octets": 2000, "in_errors": 0, "out_errors": 0, "in_discards": 0, "out_discards": 0},
        )

    def test_the_payload_is_accepted_by_the_queue_whitelist_unchanged(self):
        poll = self.poller.poll()
        _id, payload, count = sanitize_poll(poll)
        self.assertEqual(json.loads(payload), json.loads(json.dumps(poll)))
        self.assertEqual(count, 2)

    def test_the_payload_never_contains_credentials(self):
        text = json.dumps(self.poller.poll())
        self.assertNotIn(SECRET, text)
        for word in ("community", "password", "priv", "auth_key"):
            self.assertNotIn(word, text)


class RegularPollTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.fetcher = FakeFetcher(
            raw_data({1: interface(1, alias="uplink"), 2: interface(2)}, discover=True),
        )
        self.poller = make_poller(self.fetcher, self.clock)
        self.poller.poll()

    def regular(self, interfaces, **kwargs):
        self.fetcher.push(raw_data(interfaces, **kwargs))
        self.clock.advance(300)
        return self.poller.poll()

    def test_a_regular_poll_reads_counters_only_and_reuses_discovered_names(self):
        poll = self.regular({1: interface(1, in_octets64=4000, out_octets64=2500), 2: interface(2)}, uptime=1_030_000)
        self.assertFalse(self.fetcher.plans[1].discover)
        self.assertNotIn("system", poll)
        self.assertNotIn("interfaces_complete", poll)
        one = entries(poll)[1]
        self.assertEqual((one["name"], one["descr"], one["alias"], one["if_type"]), ("Gi0/1", "GigabitEthernet0/1", "uplink", 6))

    def test_deltas_and_interval(self):
        poll = self.regular({1: interface(1, in_octets64=4000, out_octets64=2500, in_errors=3), 2: interface(2)}, uptime=1_030_000)
        counters = entries(poll)[1]["counters"]
        self.assertEqual(counters["delta_state"], "ok")
        self.assertEqual(counters["interval_seconds"], 300.0)
        self.assertEqual(
            counters["delta"],
            {"in_octets": 3000, "out_octets": 500, "in_errors": 3, "out_errors": 0, "in_discards": 0, "out_discards": 0},
        )
        self.assertEqual(counters["raw"]["in_octets"], 4000)

    def test_polls_get_distinct_ids_and_times(self):
        first = self.regular({1: interface(1), 2: interface(2)}, uptime=1_030_000)
        second = self.regular({1: interface(1), 2: interface(2)}, uptime=1_060_000)
        self.assertNotEqual(first["poll_id"], second["poll_id"])
        self.assertNotEqual(first["measured_at"], second["measured_at"])

    def test_a_device_reboot_is_reported_and_triggers_rediscovery(self):
        poll = self.regular({1: interface(1, in_octets64=5), 2: interface(2, in_octets64=5)}, uptime=500)
        self.assertEqual(entries(poll)[1]["counters"]["delta_state"], "reboot")
        self.assertNotIn("delta", entries(poll)[1]["counters"])
        self.fetcher.push(raw_data({1: interface(1), 2: interface(2)}, uptime=30_500, discover=True))
        self.clock.advance(300)
        self.poller.poll()
        self.assertTrue(self.fetcher.plans[-1].discover)

    def test_a_counter_reset_is_reported(self):
        poll = self.regular({1: interface(1, in_octets64=5000), 2: interface(2)}, uptime=1_030_000)
        self.assertEqual(entries(poll)[1]["counters"]["delta_state"], "ok")
        poll = self.regular({1: interface(1, in_octets64=1), 2: interface(2)}, uptime=1_060_000)
        self.assertEqual(entries(poll)[1]["counters"]["delta_state"], "reset")

    def test_a_long_outage_gives_a_gap_not_a_huge_delta(self):
        self.fetcher.push(unreachable("timeout"))
        self.clock.advance(300)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.poller.poll()
        self.clock.advance(300 * 6)
        self.fetcher.push(raw_data({1: interface(1, in_octets64=999_999), 2: interface(2)}, uptime=1_300_000))
        poll = self.poller.poll()
        self.assertEqual(entries(poll)[1]["counters"]["delta_state"], "gap")

    def test_a_missed_poll_still_gives_a_valid_delta_over_the_longer_interval(self):
        self.fetcher.push(unreachable("timeout"))
        self.clock.advance(300)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.poller.poll()
        self.clock.advance(300)
        self.fetcher.push(raw_data({1: interface(1, in_octets64=2000), 2: interface(2)}, uptime=1_060_000))
        counters = entries(self.poller.poll())[1]["counters"]
        self.assertEqual((counters["delta_state"], counters["interval_seconds"]), ("ok", 600.0))

    def test_speed_change_is_flagged(self):
        poll = self.regular({1: interface(1, high_speed=100), 2: interface(2)}, uptime=1_030_000)
        counters = entries(poll)[1]["counters"]
        self.assertEqual(counters["delta_state"], "speed_changed")
        self.assertIn("delta", counters)
        self.assertEqual(entries(poll)[1]["speed_bps"], 100_000_000)


class RediscoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.fetcher = FakeFetcher(raw_data({1: interface(1), 2: interface(2)}, discover=True))
        self.poller = make_poller(self.fetcher, self.clock)
        self.poller.poll()

    def poll_again(self, *args, **kwargs):
        self.fetcher.push(raw_data(*args, **kwargs))
        self.clock.advance(300)
        return self.poller.poll()

    def test_the_table_change_marker_triggers_discovery_on_the_next_poll(self):
        self.poll_again({1: interface(1), 2: interface(2)}, marker=11)
        self.assertFalse(self.fetcher.plans[-1].discover)
        self.poll_again({1: interface(1), 2: interface(2)}, marker=11, discover=True)
        self.assertTrue(self.fetcher.plans[-1].discover)

    def test_an_unchanged_marker_does_not(self):
        for _ in range(3):
            self.poll_again({1: interface(1), 2: interface(2)}, marker=10)
        self.assertEqual([plan.discover for plan in self.fetcher.plans], [True, False, False, False])

    def test_a_new_interface_triggers_discovery_and_is_skipped_until_then(self):
        poll = self.poll_again({1: interface(1), 2: interface(2), 3: interface(3)})
        self.assertEqual(sorted(entries(poll)), [1, 2])
        poll = self.poll_again({1: interface(1), 2: interface(2), 3: interface(3)}, discover=True)
        self.assertTrue(self.fetcher.plans[-1].discover)
        self.assertEqual(sorted(entries(poll)), [1, 2, 3])
        self.assertTrue(poll["interfaces_complete"])

    def test_a_vanished_interface_triggers_discovery(self):
        poll = self.poll_again({1: interface(1)})
        self.assertEqual(sorted(entries(poll)), [1])
        self.poll_again({1: interface(1)}, discover=True)
        self.assertTrue(self.fetcher.plans[-1].discover)

    def test_discovery_repeats_at_its_interval(self):
        dev = device(discovery_interval_seconds=600)
        fetcher = FakeFetcher(raw_data({1: interface(1)}, discover=True))
        poller = make_poller(fetcher, self.clock, dev=dev)
        poller.poll()
        fetcher.push(raw_data({1: interface(1)}))
        self.clock.advance(300)
        poller.poll()
        fetcher.push(raw_data({1: interface(1)}, discover=True))
        self.clock.advance(300)
        poller.poll()
        self.assertEqual([plan.discover for plan in fetcher.plans], [True, False, True])


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()

    def discover(self, table, **device_kwargs):
        fetcher = FakeFetcher(raw_data(table, discover=True))
        poller = make_poller(fetcher, self.clock, dev=device(**device_kwargs))
        return poller.poll()

    def test_virtual_interfaces_are_listed_but_not_monitored_by_default(self):
        poll = self.discover(
            {
                1: interface(1),
                2: interface(2, name="Loopback0", descr="Loopback0", type=24),
                3: interface(3, name="Vlan10", descr="Vlan10", type=53),
                4: interface(4, name="Tunnel1", descr="Tunnel1", type=131),
                5: interface(5, name="Gi1/1.100", descr="Gi1/1.100", type=135),
                6: interface(6, name="Po1", descr="Po1", type=161),
            }
        )
        monitored = sorted(i for i, e in entries(poll).items() if "counters" in e)
        self.assertEqual(monitored, [1, 6])
        self.assertEqual(sorted(entries(poll)), [1, 2, 3, 4, 5, 6])
        self.assertTrue(poll["interfaces_complete"])

    def test_include_patterns_restrict_and_override_the_type_rule(self):
        poll = self.discover(
            {1: interface(1), 2: interface(2), 3: interface(3, name="Vlan10", descr="Vlan10", type=53)},
            interfaces=selection(include=["Gi0/2", "Vlan*"]),
        )
        self.assertEqual(sorted(i for i, e in entries(poll).items() if "counters" in e), [2, 3])

    def test_exclude_patterns_always_win(self):
        poll = self.discover(
            {1: interface(1), 2: interface(2)},
            interfaces=selection(include=["Gi0/*"], exclude=["Gi0/2"]),
        )
        self.assertEqual(sorted(i for i, e in entries(poll).items() if "counters" in e), [1])

    def test_patterns_match_the_description_too_and_are_case_sensitive(self):
        poll = self.discover(
            {1: interface(1, name="Gi0/1", descr="GigabitEthernet0/1")},
            interfaces=selection(include=["GigabitEthernet*"]),
        )
        self.assertIn("counters", entries(poll)[1])
        poll = self.discover({1: interface(1)}, interfaces=selection(include=["gigabit*"]))
        self.assertNotIn("counters", entries(poll)[1])

    def test_the_cap_limits_monitored_interfaces_and_warns_once(self):
        fetcher = FakeFetcher(raw_data({i: interface(i) for i in range(1, 11)}, discover=True))
        poller = make_poller(fetcher, self.clock, dev=device(interfaces=selection(max_interfaces=4)))
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            poll = poller.poll()
        self.assertEqual(sorted(i for i, e in entries(poll).items() if "counters" in e), [1, 2, 3, 4])
        self.assertEqual(len(entries(poll)), 10)
        self.assertEqual(sum("monitoring the first 4" in line for line in logs.output), 1)

    def test_select_interfaces_is_deterministic_and_sorted(self):
        class Info:
            def __init__(self, index, name, if_type=6):
                self.if_index, self.name, self.descr, self.if_type = index, name, name, if_type

        chosen = select_interfaces([Info(3, "c"), Info(1, "a"), Info(2, "b", 24)], selection())
        self.assertEqual(chosen, [1, 3])

    def test_more_than_512_interfaces_cannot_be_listed_completely(self):
        interfaces = {i: interface(i) for i in range(1, 601)}
        fetcher = FakeFetcher(raw_data(interfaces, discover=True))
        poller = make_poller(fetcher, self.clock, dev=device(interfaces=selection(max_interfaces=512)))
        with self.assertLogs("sentinel_agent", level="WARNING"):
            poll = poller.poll()
        self.assertEqual(len(poll["interfaces"]), 512)
        self.assertFalse(poll["interfaces_complete"])
        sanitize_poll(poll)  # still within what the server accepts


class CounterWidthTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()

    def test_32_bit_counters_are_used_when_there_are_no_64_bit_ones(self):
        fetcher = FakeFetcher(
            raw_data(
                {1: interface(1, in_octets64=None, out_octets64=None, in_octets32=4_294_967_000, out_octets32=10)},
                discover=True,
            ),
            raw_data({1: interface(1, in_octets64=None, out_octets64=None, in_octets32=700, out_octets32=60)}),
        )
        poller = make_poller(fetcher, self.clock)
        first = entries(poller.poll())[1]["counters"]
        self.assertEqual((first["octets_bits"], first["raw"]["in_octets"]), (32, 4_294_967_000))
        self.clock.advance(300)
        second = entries(poller.poll())[1]["counters"]
        self.assertEqual((second["delta_state"], second["delta"]["in_octets"], second["delta"]["out_octets"]), ("ok", 996, 50))

    def test_a_64_bit_pair_wins_over_32_bit(self):
        fetcher = FakeFetcher(
            raw_data({1: interface(1, in_octets32=5, out_octets32=6)}, discover=True),
        )
        counters = entries(make_poller(fetcher, self.clock).poll())[1]["counters"]
        self.assertEqual((counters["octets_bits"], counters["raw"]["in_octets"]), (64, 1000))

    def test_switching_width_between_polls_is_a_reset(self):
        fetcher = FakeFetcher(
            raw_data({1: interface(1)}, discover=True),
            raw_data({1: interface(1, in_octets64=None, out_octets64=None, in_octets32=5, out_octets32=6)}),
        )
        poller = make_poller(fetcher, self.clock)
        poller.poll()
        self.clock.advance(300)
        self.assertEqual(entries(poller.poll())[1]["counters"]["delta_state"], "reset")

    def test_missing_counters_are_null_not_zero(self):
        fetcher = FakeFetcher(raw_data({1: interface(1, in_errors=None, out_discards=None)}, discover=True))
        raw = entries(make_poller(fetcher, self.clock).poll())[1]["counters"]["raw"]
        self.assertIsNone(raw["in_errors"])
        self.assertIsNone(raw["out_discards"])
        self.assertEqual(raw["out_errors"], 0)

    def test_out_of_range_values_are_sent_as_null(self):
        fetcher = FakeFetcher(raw_data({1: interface(1, in_octets64=2**63, in_errors=2**32)}, discover=True))
        raw = entries(make_poller(fetcher, self.clock).poll())[1]["counters"]["raw"]
        self.assertIsNone(raw["in_octets"])
        self.assertIsNone(raw["in_errors"])


class FieldSanityTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()

    def poll(self, interfaces, **kwargs):
        return make_poller(FakeFetcher(raw_data(interfaces, discover=True, **kwargs)), self.clock).poll()

    def test_interfaces_with_out_of_range_status_are_skipped_so_the_poll_is_accepted(self):
        poll = self.poll({1: interface(1), 2: interface(2, oper=9), 3: interface(3, admin=0), 4: interface(4, oper=None)})
        self.assertEqual(sorted(entries(poll)), [1])
        self.assertFalse(poll["interfaces_complete"])

    def test_speed_prefers_ifhighspeed_then_ifspeed(self):
        poll = self.poll(
            {
                1: interface(1, high_speed=10_000),
                2: interface(2, high_speed=0, speed=100_000_000),
                3: interface(3, high_speed=0, speed=4_294_967_295),
                4: interface(4, high_speed=None, speed=None),
                5: interface(5, high_speed=0, speed=0),
            }
        )
        speeds = {i: e["speed_bps"] for i, e in entries(poll).items()}
        self.assertEqual(speeds, {1: 10_000_000_000, 2: 100_000_000, 3: None, 4: None, 5: None})

    def test_text_falls_back_from_name_to_description(self):
        poll = self.poll({1: interface(1, name=None, descr="Port 1")})
        self.assertEqual(entries(poll)[1]["name"], "Port 1")

    def test_uptime_beyond_32_bits_is_omitted(self):
        poll = self.poll({1: interface(1)}, uptime=2**32)
        self.assertNotIn("sys_uptime_ticks", poll)

    def test_an_empty_interface_table_is_reachable_with_no_interfaces_and_never_complete(self):
        fetcher = FakeFetcher(raw_data({}, discover=True))
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            poll = make_poller(fetcher, self.clock).poll()
        self.assertTrue(poll["reachable"])
        self.assertEqual(poll["interfaces"], [])
        self.assertFalse(poll["interfaces_complete"])  # an empty answer must not mark everything absent
        self.assertIn("no interfaces", "\n".join(logs.output))


class OddDeviceValueTests(unittest.TestCase):
    """Values that would make the server reject a whole poll must never be sent."""

    def setUp(self):
        self.clock = Clock()

    def discover(self, table, **kwargs):
        return make_poller(FakeFetcher(raw_data(table, discover=True, **kwargs)), self.clock).poll()

    def test_interfaces_with_an_ifindex_the_server_rejects_are_ignored(self):
        poll = self.discover({0: interface(0), 1: interface(1), 2**31: interface(2**31), 2**31 - 1: interface(2**31 - 1), -4: interface(-4)})
        self.assertEqual(sorted(entries(poll)), [1, 2**31 - 1])
        self.assertTrue(poll["interfaces_complete"] in (True, False))
        sanitize_poll(poll)

    def test_a_sysobjectid_that_is_not_a_dotted_oid_is_left_out(self):
        for bad in ("enterprises.9.1", "1", "1.3.6.", ".1.3.6", "1.3.6.1.4.1.x", "", "1." + "1." * 200 + "1"):
            with self.subTest(bad):
                poll = self.discover({1: interface(1)}, system={"name": "sw", "descr": "d", "object_id": bad})
                self.assertNotIn("object_id", poll["system"])
                self.assertEqual(poll["system"]["name"], "sw")
        poll = self.discover({1: interface(1)}, system={"name": "sw", "descr": "d", "object_id": "1.3.6.1.4.1.9.1.2504"})
        self.assertEqual(poll["system"]["object_id"], "1.3.6.1.4.1.9.1.2504")

    def test_an_uptime_outside_the_32_bit_range_is_omitted_and_never_a_reboot(self):
        fetcher = FakeFetcher(raw_data({1: interface(1)}, discover=True, uptime=500_000))
        poller = make_poller(fetcher, self.clock)
        poller.poll()
        for bad in (-1, -2**31, 2**32, 2**40):
            fetcher.push(raw_data({1: interface(1)}, uptime=bad))
            self.clock.advance(300)
            poll = poller.poll()
            self.assertNotIn("sys_uptime_ticks", poll)
            self.assertNotEqual(entries(poll)[1]["counters"]["delta_state"], "reboot")
        fetcher.push(raw_data({1: interface(1)}, uptime=530_000))
        self.clock.advance(300)
        self.assertEqual(entries(poller.poll())[1]["counters"]["delta_state"], "ok")  # still compares against 500_000

    def test_long_descriptive_text_is_shortened_not_rejected(self):
        poll = self.discover(
            {1: interface(1, name="n" * 400, descr="d" * 400, alias="a" * 400)},
            system={"name": "s" * 400, "descr": "z" * 5000, "object_id": "1.3.6.1.4.1.9"},
        )
        one = entries(poll)[1]
        self.assertEqual((len(one["name"]), len(one["descr"]), len(one["alias"])), (128, 128, 64))
        self.assertEqual((len(poll["system"]["name"]), len(poll["system"]["descr"])), (255, 1024))

    def test_text_that_cannot_be_encoded_is_made_safe(self):
        poll = self.discover({1: interface(1, name="Gi\ud800/1", descr="d\udfff", alias="a\ud800")})
        sanitize_poll(poll)  # would raise on a lone surrogate
        self.assertEqual(entries(poll)[1]["name"], "Gi?/1")

    def test_512_interfaces_of_worst_case_text_still_fit_one_queued_poll(self):
        text = "日本語" * 100  # three UTF-8 bytes per character, longer than every limit
        table = {i: interface(i, name=text, descr=text, alias=text) for i in range(1, 513)}
        poller = make_poller(FakeFetcher(raw_data(table, discover=True)), self.clock, dev=device(interfaces=selection(max_interfaces=512)))
        poll = poller.poll()
        _id, payload, count = sanitize_poll(poll)
        self.assertEqual(count, 512)
        self.assertLess(len(payload.encode("utf-8")), 700_000)


class UnreachableTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.fetcher = FakeFetcher()
        self.poller = make_poller(self.fetcher, self.clock)

    def test_an_unreachable_poll_carries_only_what_the_server_allows(self):
        self.fetcher.push(unreachable("auth_failure", "Wrong SNMP PDU digest"))
        with self.assertLogs("sentinel_agent", level="WARNING"):
            poll = self.poller.poll()
        self.assertEqual(
            poll,
            {
                "poll_id": poll["poll_id"],
                "device_id": str(device().id),
                "measured_at": "2026-10-12T14:00:00+00:00",
                "reachable": False,
                "error": "auth_failure",
            },
        )
        sanitize_poll(poll)

    def test_state_changes_are_logged_once_not_per_poll(self):
        self.fetcher.push(unreachable("timeout"), unreachable("timeout"), unreachable("auth_failure"))
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            for _ in range(3):
                self.clock.advance(300)
                self.poller.poll()
        self.assertEqual(len(logs.output), 2)  # timeout once, then auth_failure once
        self.fetcher.push(raw_data({1: interface(1)}, discover=True))
        with self.assertLogs("sentinel_agent", level="INFO") as logs:
            self.poller.poll()
        self.assertIn("reachable again", "\n".join(logs.output))

    def test_the_failed_first_poll_is_retried_as_discovery(self):
        self.fetcher.push(unreachable("timeout"), raw_data({1: interface(1)}, discover=True))
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.poller.poll()
        self.poller.poll()
        self.assertEqual([plan.discover for plan in self.fetcher.plans], [True, True])

    def test_cancellation_propagates(self):
        self.fetcher.push(SnmpFetchCancelled("stopping"))
        with self.assertRaises(SnmpFetchCancelled):
            self.poller.poll(cancel=threading.Event())

    def test_the_credential_reaches_the_fetcher_but_not_the_payload(self):
        credential = community()
        fetcher = FakeFetcher(raw_data({1: interface(1)}, discover=True))
        poll = make_poller(fetcher, self.clock, credential=credential).poll()
        self.assertIs(fetcher.credentials[0], credential)
        self.assertNotIn(SECRET, json.dumps(poll))


if __name__ == "__main__":
    unittest.main()
