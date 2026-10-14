"""Traffic deltas across counter discontinuities (IF-MIB ``ifCounterDiscontinuityTime``).

``ifCounterDiscontinuityTime`` (ifXTable column 19) is the value of ``sysUpTime``,
in hundredths of a second since the device's management agent last started, at
the most recent moment any counter of the interface suffered a discontinuity
(cleared, interface re-initialized), and 0 if none since then. It is not a wall
clock: a restart of the device starts a new ``sysUpTime`` epoch, so values from
before and after a restart cannot be compared.

The fake device here reports it as the column ``discontinuity``. A delta is
valid only if nothing discontinuous happened between the two reads, whatever the
two counter values look like: a counter that was cleared and has grown past its
old value, or a 32-bit one that restarted near zero after a high reading, looks
like ordinary traffic to a comparison of the values alone.

Interface identity and the interface table are covered here too: an ifIndex
that vanished and came back, or is now another interface, has no comparable
previous reading.
"""

import logging
import unittest
from datetime import timedelta

from agent.snmp_collector import FREQUENT_MARKER_CHANGES, FREQUENT_MARKER_WARNING_SECONDS, DevicePoller
from agent.snmp_deltas import CounterSnapshot, compute_delta, uptime_wrapped, usable_marker
from agent.tests.snmp_helpers import Clock, FakeFetcher, device, ids, interface, raw_data, v3

UPTIME = 1_000_000  # sysUpTime of the first poll, in ticks (hundredths of a second)
STEP = 30_000  # ticks in one 300 s poll interval
NO_64_BIT = {"in_octets64": None, "out_octets64": None}


def counters(poll, index=1):
    (entry,) = [e for e in poll["interfaces"] if e["if_index"] == index]
    return entry["counters"]


class DiscontinuityTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.fetcher = FakeFetcher()
        self.poller = self.new_poller()
        self.uptime = UPTIME

    def new_poller(self):
        return DevicePoller(
            device(), v3(), self.fetcher, monotonic=self.clock.monotonic, utcnow=self.clock.utcnow, new_id=ids()
        )

    def poll(self, interfaces=None, *, uptime=None, advance=300, discover=False, took=0, wall_jump=None, **kwargs):
        """One poll ``advance`` seconds after the last; the uptime moves on by as much unless given.

        ``took``: seconds on the monotonic clock that the fetch itself takes (the walks); ``wall_jump``
        steps the wall clock by that much meanwhile, which must make no difference.
        """
        if uptime is None:
            self.uptime += int(advance * 100)
        else:
            self.uptime = uptime
        data = raw_data(interfaces or {1: interface(1)}, uptime=self.uptime, discover=discover, **kwargs)
        if took or wall_jump:

            def slow(plan):
                self.clock.now += took
                if wall_jump:
                    self.clock.wall += wall_jump
                return data

            self.fetcher.push(slow)
        else:
            self.fetcher.push(data)
        self.clock.advance(advance)
        return self.poller.poll()

    def start(self, interfaces=None, **kwargs):
        """The discovery poll that is the first sample."""
        self.fetcher.push(raw_data(interfaces or {1: interface(1)}, uptime=self.uptime, discover=True, **kwargs))
        return self.poller.poll()


class CountersThatKeepCountingTests(DiscontinuityTestCase):
    def test_normal_traffic_is_a_valid_delta(self):
        self.start({1: interface(1, in_octets64=1000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=4000, discontinuity=0)}))
        self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 3000))

    def test_a_discontinuity_long_before_the_previous_poll_is_not_between_the_polls(self):
        self.start({1: interface(1, in_octets64=1000, discontinuity=400_000)})
        result = counters(self.poll({1: interface(1, in_octets64=4000, discontinuity=400_000)}))
        self.assertEqual(result["delta_state"], "ok")

    def test_32_bit_rollover_is_not_a_discontinuity(self):
        # 32-bit octet counter wrapping on a busy gigabit link: the marker did not move.
        self.start({1: interface(1, in_octets32=4_294_000_000, out_octets32=10, discontinuity=0, **NO_64_BIT)})
        result = counters(self.poll({1: interface(1, in_octets32=500_000, out_octets32=20, discontinuity=0, **NO_64_BIT)}))
        self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 4_294_967_296 + 500_000 - 4_294_000_000))

    def test_a_64_bit_counter_beyond_what_the_server_stores_is_never_a_delta(self):
        self.start({1: interface(1, in_octets64=2**63 + 5, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=2**63 + 9, discontinuity=0)}))
        self.assertIsNone(result["raw"]["in_octets"])


class ClearedCountersTests(DiscontinuityTestCase):
    def test_a_64_bit_counter_cleared_and_grown_past_its_old_value(self):
        # Cleared (marker moved) and 8,000 bytes later already above the old 5,000: not 3,000 bytes of traffic.
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=1_015_000)}))
        self.assertEqual(result["delta_state"], "reset")
        self.assertNotIn("delta", result)

    def test_a_32_bit_counter_cleared_near_zero_after_a_high_reading(self):
        # 4,000,000,000 then 100: as a wrap it is 295 MB in 5 minutes, which a gigabit link could carry.
        self.start({1: interface(1, in_octets32=4_000_000_000, out_octets32=10, discontinuity=0, **NO_64_BIT)})
        result = counters(self.poll({1: interface(1, in_octets32=100, out_octets32=20, discontinuity=1_020_000, **NO_64_BIT)}))
        self.assertEqual(result["delta_state"], "reset")

    def test_the_errors_and_discards_count_as_well(self):
        self.start({1: interface(1, in_errors=10, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_errors=50, discontinuity=1_005_000)}))
        self.assertEqual(result["delta_state"], "reset")

    def test_the_delta_is_valid_again_from_the_next_poll(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        self.poll({1: interface(1, in_octets64=8_000, discontinuity=1_015_000)})
        result = counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=1_015_000)}))
        self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 1_000))

    def test_a_cleared_counter_that_the_marker_does_not_announce_is_found_only_if_it_went_down(self):
        # A device that never updates the marker: the old rule still catches a decrease ...
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=10, discontinuity=0)}))["delta_state"], "reset")
        # ... and cannot see a counter that has grown past its old value (the known limit).
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=0)}))["delta_state"], "ok")

    def test_a_decrease_is_still_a_reset_when_the_marker_moved_too(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=10, discontinuity=1_020_000)}))
        self.assertEqual(result["delta_state"], "reset")


class RestartsTests(DiscontinuityTestCase):
    def test_a_device_reboot_is_a_reboot_and_the_marker_of_the_new_epoch_does_not_matter(self):
        for marker in (0, 400_000, 12_000, 999_999_999):
            with self.subTest(marker=marker):
                self.poller = self.new_poller()
                self.uptime = UPTIME
                self.start({1: interface(1, in_octets64=5_000, discontinuity=400_000)})
                result = counters(self.poll({1: interface(1, in_octets64=7_000, discontinuity=marker)}, uptime=3_000))
                self.assertEqual(result["delta_state"], "reboot")

    def test_the_first_poll_after_an_agent_restart_has_no_delta_and_the_next_one_compares_markers(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        self.poller = self.new_poller()  # the agent restarted: it remembers nothing
        first = counters(self.start({1: interface(1, in_octets64=8_000, discontinuity=700_000)}))
        self.assertEqual(first["delta_state"], "first")
        steady = counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=700_000)}))
        self.assertEqual(steady["delta_state"], "ok")
        cleared = counters(self.poll({1: interface(1, in_octets64=9_500, discontinuity=1_050_000)}))
        self.assertEqual(cleared["delta_state"], "reset")


class InterfaceIdentityTests(DiscontinuityTestCase):
    two = {1: interface(1), 2: interface(2)}

    def test_an_interface_that_vanished_and_returned_has_no_delta_across_the_absence(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0), 2: interface(2)})
        self.poll({2: interface(2)})  # interface 1 is gone for a poll
        back = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=0), 2: interface(2)}, discover=True))
        self.assertEqual(back["delta_state"], "first")
        steady = counters(self.poll({1: interface(1, in_octets64=6_500, discontinuity=0), 2: interface(2)}))
        self.assertEqual(steady["delta_state"], "ok")  # and from then on it is compared with the return

    def test_an_ifindex_reused_by_another_interface_has_no_delta(self):
        # No marker on this device. The poll that sees the table change cannot show the interface is the
        # same one (reset); the discovery poll after it sees another interface under the index (first).
        self.start({1: interface(1, in_octets64=5_000), 2: interface(2)})
        reused = dict(interface(1, in_octets64=9_000), name="Po1", descr="Po1", type=161)
        self.assertEqual(counters(self.poll({1: reused, 2: interface(2)}, marker=11))["delta_state"], "reset")
        found = counters(self.poll({1: reused, 2: interface(2)}, marker=11, discover=True))
        self.assertEqual(found["delta_state"], "first")
        self.assertEqual(counters(self.poll({1: reused, 2: interface(2)}, marker=11))["delta_state"], "ok")

    def test_an_ifindex_reused_by_another_interface_is_a_first_reading_even_when_the_table_marker_is_missing(self):
        self.start({1: interface(1, in_octets64=5_000), 2: interface(2)}, marker=None)
        reused = dict(interface(1, in_octets64=9_000), name="Po1", descr="Po1", type=161)
        self.poller._rediscover = True  # a discovery for another reason (its interval, a restart)
        found = counters(self.poll({1: reused, 2: interface(2)}, marker=None, discover=True))
        self.assertEqual(found["delta_state"], "first")

    def test_only_the_name_and_the_type_make_an_identity_not_the_description_or_the_alias(self):
        for change, expected in (
            ({"alias": "uplink to dc2"}, "ok"),
            ({"descr": "GigabitEthernet0/1 (renamed)"}, "ok"),
            ({"name": "Gi0/11"}, "first"),
            ({"type": 161}, "first"),
        ):
            with self.subTest(change=change):
                self.setUp()
                self.start({1: interface(1, in_octets64=5_000), 2: interface(2)}, marker=None)
                self.poller._rediscover = True
                changed = dict(interface(1, in_octets64=6_000), **change)
                self.assertEqual(counters(self.poll({1: changed, 2: interface(2)}, marker=None, discover=True))["delta_state"], expected)

    def test_an_interface_that_is_renamed_but_is_the_same_keeps_its_delta(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0), 2: interface(2)})
        renamed = interface(1, in_octets64=6_000, discontinuity=0, alias="uplink to dc2")
        poll = self.poll({1: renamed, 2: interface(2)}, discover=True, marker=11)
        self.assertEqual(counters(poll)["delta_state"], "ok")


class MarkerSupportTests(DiscontinuityTestCase):
    def test_a_device_without_the_column_is_judged_as_before(self):
        self.start({1: interface(1, in_octets64=5_000)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=8_000)}))["delta_state"], "ok")
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=10)}))["delta_state"], "reset")

    def test_a_marker_that_is_always_zero_is_judged_as_before(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=0)}))["delta_state"], "ok")

    def test_a_marker_that_comes_and_goes_is_not_taken_as_a_discontinuity(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=6_000)}))["delta_state"], "ok")
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=7_000, discontinuity=0)}))["delta_state"], "ok")

    def test_a_marker_in_the_future_of_the_device_is_not_believed(self):
        # A value above sysUpTime cannot be a moment that has passed: nothing is concluded from it.
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_000_000_000)}))
        self.assertEqual(result["delta_state"], "ok")


class DelayedPollsTests(DiscontinuityTestCase):
    def test_a_missed_poll_still_gives_a_delta_over_the_longer_interval_if_nothing_was_cleared(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=0)}, advance=600))
        self.assertEqual((result["delta_state"], result["interval_seconds"]), ("ok", 600.0))

    def test_a_clearing_in_the_missed_poll_is_found_in_the_next_one(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=1_020_000)}, advance=600))
        self.assertEqual(result["delta_state"], "reset")


class InterfaceTableChangeTests(DiscontinuityTestCase):
    """``ifTableLastChange`` moved: rows were created or deleted, and it does not say which."""

    def test_an_interface_without_the_marker_cannot_be_shown_to_be_the_same_one(self):
        self.start({1: interface(1, in_octets64=5_000), 2: interface(2, in_octets64=5_000)})
        poll = self.poll({1: interface(1, in_octets64=6_000), 2: interface(2, in_octets64=6_000)}, marker=11)
        self.assertEqual([counters(poll, i)["delta_state"] for i in (1, 2)], ["reset", "reset"])
        # The poll after it is a discovery poll: the same names and types, so the readings go on.
        after = self.poll({1: interface(1, in_octets64=7_000), 2: interface(2, in_octets64=7_000)}, marker=11, discover=True)
        self.assertEqual([counters(after, i)["delta_state"] for i in (1, 2)], ["ok", "ok"])

    def test_an_interface_with_the_marker_on_both_reads_is_judged_by_the_marker_alone(self):
        both = {1: interface(1, in_octets64=5_000, discontinuity=0), 2: interface(2, in_octets64=5_000, discontinuity=0)}
        self.start(both)
        moved = {1: interface(1, in_octets64=6_000, discontinuity=0), 2: interface(2, in_octets64=6_000, discontinuity=1_020_000)}
        poll = self.poll(moved, marker=11)
        self.assertEqual([counters(poll, i)["delta_state"] for i in (1, 2)], ["ok", "reset"])

    def test_an_unrelated_interface_added_or_removed_costs_the_interfaces_with_the_marker_nothing(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0), 2: interface(2, in_octets64=5_000, discontinuity=0)})
        added = self.poll(
            {1: interface(1, in_octets64=6_000, discontinuity=0), 2: interface(2, in_octets64=6_000, discontinuity=0), 3: interface(3)},
            marker=11,
        )
        self.assertEqual([counters(added, i)["delta_state"] for i in (1, 2)], ["ok", "ok"])
        found = self.poll(
            {1: interface(1, in_octets64=7_000, discontinuity=0), 2: interface(2, in_octets64=7_000, discontinuity=0), 3: interface(3)},
            marker=11,
            discover=True,
        )
        self.assertEqual([counters(found, i)["delta_state"] for i in (1, 2, 3)], ["ok", "ok", "first"])
        removed = self.poll({1: interface(1, in_octets64=8_000, discontinuity=0), 3: interface(3)}, marker=12)
        self.assertEqual(counters(removed, 1)["delta_state"], "ok")
        self.assertEqual(sorted(e["if_index"] for e in removed["interfaces"]), [1, 3])

    def test_without_the_marker_an_unrelated_change_costs_one_reading_per_interface_and_no_more(self):
        self.start({1: interface(1, in_octets64=5_000), 2: interface(2, in_octets64=5_000)})
        self.poll({1: interface(1, in_octets64=6_000), 2: interface(2, in_octets64=6_000), 3: interface(3)}, marker=11)
        found = self.poll({1: interface(1, in_octets64=7_000), 2: interface(2, in_octets64=7_000), 3: interface(3)}, marker=11, discover=True)
        self.assertEqual([counters(found, i)["delta_state"] for i in (1, 2, 3)], ["ok", "ok", "first"])

    def test_an_unchanged_or_unsupported_table_marker_invalidates_nothing(self):
        for marker in (10, None):
            with self.subTest(table_marker=marker):
                self.setUp()
                self.start({1: interface(1, in_octets64=5_000)}, marker=marker)
                self.assertEqual(counters(self.poll({1: interface(1, in_octets64=6_000)}, marker=marker))["delta_state"], "ok")

    def test_a_marker_on_one_read_only_does_not_prove_anything_across_a_table_change(self):
        self.start({1: interface(1, in_octets64=5_000)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=0)}, marker=11))["delta_state"], "reset")

    def test_a_reboot_is_a_reboot_whatever_the_table_did(self):
        self.start({1: interface(1, in_octets64=5_000)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=6_000)}, marker=11, uptime=3_000))["delta_state"], "reboot")


class UptimeEpochTests(DiscontinuityTestCase):
    """The marker is a ``sysUpTime`` value: compared only within one epoch, and a wrap is not a restart."""

    WRAPPING = 4_294_950_000  # 17,296 ticks before the 32-bit counter wraps: one poll later (30,000) it has, at 12,704

    def test_a_sysuptime_wrap_is_neither_a_reboot_nor_a_discontinuity(self):
        self.uptime = self.WRAPPING
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        # The wrapped uptime is small; the marker, from before the wrap, is above it and still the same.
        result = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)}, uptime=12_704))
        self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 1_000))
        again = counters(self.poll({1: interface(1, in_octets64=7_000, discontinuity=4_294_000_000)}))
        self.assertEqual(again["delta_state"], "ok")

    def test_a_discontinuity_after_the_wrap_is_found(self):
        self.uptime = self.WRAPPING
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)}, uptime=12_704)
        result = counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=20_000)}))
        self.assertEqual(result["delta_state"], "reset")

    def test_a_marker_above_the_uptime_is_not_believed_unless_the_uptime_wrapped(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=3_000_000_000)}))
        self.assertEqual(result["delta_state"], "ok")  # ignored: the heuristics judge, as for a device without it
        decrease = counters(self.poll({1: interface(1, in_octets64=10, discontinuity=3_000_000_000)}))
        self.assertEqual(decrease["delta_state"], "reset")

    def test_a_reboot_starts_a_new_epoch_in_which_a_large_marker_is_not_believed_again(self):
        self.uptime = self.WRAPPING
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)}, uptime=12_704)  # wrapped
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=7_000, discontinuity=4_294_000_000)}, uptime=500))["delta_state"], "reboot")
        # In the new epoch the old large value cannot be a moment that has passed: no marker, the old rules.
        result = counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=4_000_000_000)}, discover=True))
        self.assertEqual(result["delta_state"], "ok")  # not a marker here, so not a change either
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=2, discontinuity=4_294_000_000)}))["delta_state"], "reset")

    def test_values_that_cannot_be_a_marker_are_ignored(self):
        for value in (-1, 2**32, 2**40, "x", True, 1.5):
            with self.subTest(value=value):
                self.setUp()
                self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
                with self.assertLogs("sentinel_agent", level="WARNING") as logs:
                    result = counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=value)}))
                self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 3_000))
                self.assertIn("not believed", logs.output[0])

    def test_an_invalid_value_is_reported_once_not_at_every_poll(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            for step in range(5):
                self.poll({1: interface(1, in_octets64=6_000 + step, discontinuity=-1)})
        self.assertEqual(len(logs.output), 1)


class FrequentChangesTests(DiscontinuityTestCase):
    """A marker that moves at poll after poll is still a discontinuity at every poll; the log says so, rarely."""

    def run_polls(self, count):
        states = []
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            logging.getLogger("sentinel_agent").warning("anchor")  # assertLogs fails when nothing is logged
            for step in range(count):
                self.uptime += 30_000
                self.fetcher.push(
                    raw_data({1: interface(1, in_octets64=6_000 + 1000 * step, discontinuity=self.uptime - 100)}, uptime=self.uptime)
                )
                self.clock.advance(300)
                states.append(counters(self.poller.poll())["delta_state"])
        messages = [m for m in logs.output if "ifCounterDiscontinuityTime of" in m]
        return states, messages

    def test_every_change_is_a_reset_and_the_detection_is_never_switched_off(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        states, messages = self.run_polls(12)
        self.assertEqual(states, ["reset"] * 12)

    def test_the_warning_comes_after_three_in_a_row_and_at_most_once_an_hour(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        states, messages = self.run_polls(FREQUENT_MARKER_CHANGES - 1)
        self.assertEqual(messages, [])
        states, messages = self.run_polls(1)  # the third in a row
        self.assertEqual(len(messages), 1)
        self.assertIn("treated as a counter discontinuity", messages[0])
        states, messages = self.run_polls(8)  # 11 polls in all, just under an hour after the first warning
        self.assertEqual(messages, [])  # not again within the hour
        states, messages = self.run_polls(int(FREQUENT_MARKER_WARNING_SECONDS // 300) + 1)
        self.assertEqual(len(messages), 1)  # the next one, an hour later: not one per poll

    def test_a_marker_that_settles_stops_the_count(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        self.run_polls(FREQUENT_MARKER_CHANGES - 1)
        self.assertEqual(self.poller._marker_streak[1], FREQUENT_MARKER_CHANGES - 1)
        last = self.uptime - 100  # the marker of the last poll, unchanged now
        self.poll({1: interface(1, in_octets64=90_000, discontinuity=last)})
        self.assertEqual(self.poller._marker_streak[1], 0)


class DeltaRuleTests(unittest.TestCase):
    """``compute_delta`` and the helpers on their own."""

    def snap(self, at, in_octets, marker=None):
        return CounterSnapshot(at, 64, 1_000_000_000, {"in_octets": in_octets}, marker)

    def delta(self, previous, current, **kwargs):
        kwargs.setdefault("rebooted", False)
        kwargs.setdefault("max_gap_seconds", 1050)
        return compute_delta(previous, current, **kwargs)

    def test_a_changed_marker_is_a_reset_an_unchanged_one_a_delta(self):
        self.assertEqual(self.delta(self.snap(0, 100, 5), self.snap(300, 400, 6)).state, "reset")
        self.assertEqual(self.delta(self.snap(0, 100, 5), self.snap(300, 400, 5)).state, "ok")
        self.assertEqual(self.delta(self.snap(0, 100, 5), self.snap(300, 400, 4)).state, "reset")  # it cannot go back

    def test_a_marker_on_one_read_only_is_no_evidence(self):
        for before, after in ((None, 6), (5, None), (None, None)):
            self.assertEqual(self.delta(self.snap(0, 100, before), self.snap(300, 400, after)).state, "ok")
            self.assertEqual(self.delta(self.snap(0, 100, before), self.snap(300, 400, after), table_changed=True).state, "reset")

    def test_the_reboot_and_the_gap_come_before_the_marker(self):
        changed = (self.snap(0, 100, 5), self.snap(300, 400, 6))
        self.assertEqual(self.delta(*changed, rebooted=True).state, "reboot")
        self.assertEqual(self.delta(*changed, max_gap_seconds=100).state, "gap")

    def test_an_observation_that_is_not_after_the_previous_one_has_no_delta_whatever_the_marker(self):
        for marker in (5, 6):
            result = self.delta(self.snap(300, 100, 5), self.snap(0, 400, marker))
            self.assertEqual((result.state, result.delta), ("gap", None))

    def test_the_first_reading_has_no_delta(self):
        self.assertEqual(self.delta(None, self.snap(0, 400, 5)).state, "first")

    def test_a_marker_is_usable_only_as_a_moment_of_the_device_s_own_uptime(self):
        self.assertEqual(usable_marker(0, 100, wrapped=False), 0)
        self.assertEqual(usable_marker(100, 100, wrapped=False), 100)
        self.assertIsNone(usable_marker(101, 100, wrapped=False))
        self.assertEqual(usable_marker(101, 100, wrapped=True), 101)
        self.assertEqual(usable_marker(101, None, wrapped=False), 101)  # no uptime to judge it by
        for bad in (-1, 2**32, "5", None, True, 1.0):
            self.assertIsNone(usable_marker(bad, 2**32 - 1, wrapped=True))

    def test_the_wrap_of_the_uptime_is_told_from_a_restart(self):
        self.assertTrue(uptime_wrapped(4_294_950_000, 12_704, 300))
        self.assertFalse(uptime_wrapped(4_294_950_000, 500, 300))  # a restart
        self.assertFalse(uptime_wrapped(100, 200, 1))  # nothing decreased
        self.assertFalse(uptime_wrapped(None, 5, 1))


class SkippedInterfaceTests(DiscontinuityTestCase):
    """A known discontinuity must not be lost because an interface was skipped in the poll that saw it.

    An interface whose administrative status row is missing is skipped for that poll (the server would
    reject a poll that listed it), so its counters are not read and its old reading survives.
    """

    def both(self, in_octets, **kwargs):
        return {1: interface(1, in_octets64=in_octets, **kwargs), 2: interface(2, in_octets64=in_octets)}

    def skipped(self, in_octets, **kwargs):
        return {1: interface(1, in_octets64=in_octets, admin=None, **kwargs), 2: interface(2, in_octets64=in_octets)}

    def test_a_reboot_seen_while_an_interface_is_skipped_still_starts_it_afresh(self):
        self.start(self.both(5_000))
        poll = self.poll(self.skipped(6_000), uptime=3_000)  # restarted; interface 1 has no admin status row
        self.assertEqual(sorted(e["if_index"] for e in poll["interfaces"]), [2])
        self.assertEqual(counters(poll, 2)["delta_state"], "reboot")
        after = self.poll(self.both(9_000), discover=True)
        self.assertEqual(counters(after, 1)["delta_state"], "first")  # not "ok" with 4,000 across the restart
        self.assertEqual(counters(after, 2)["delta_state"], "ok")

    def test_the_same_after_a_sysuptime_wrap(self):
        self.uptime = 4_294_950_000
        self.start(self.both(5_000))
        self.poll(self.both(5_500), uptime=12_704)  # the wrap: not a restart
        self.poll(self.skipped(6_000), uptime=500)  # a restart, interface 1 skipped
        after = self.poll(self.both(9_000), discover=True)
        self.assertEqual(counters(after, 1)["delta_state"], "first")

    def test_an_interface_that_vanishes_for_the_reboot_poll_is_afresh_too(self):
        self.start(self.both(5_000))
        self.poll({2: interface(2, in_octets64=6_000)}, uptime=3_000)
        after = self.poll(self.both(9_000), discover=True)
        self.assertEqual(counters(after, 1)["delta_state"], "first")

    def test_a_table_change_seen_while_an_interface_is_skipped_is_not_consumed(self):
        self.start(self.both(5_000), marker=10)
        self.poll(self.skipped(6_000), marker=11)  # the table changed; interface 1 was skipped
        after = self.poll(self.both(7_000), marker=11, discover=True)
        self.assertEqual(counters(after, 1)["delta_state"], "reset")  # continuity could not be shown
        self.assertEqual(counters(after, 2)["delta_state"], "ok")  # the interface that was read is judged as usual
        again = self.poll(self.both(8_000), marker=11)
        self.assertEqual(counters(again, 1)["delta_state"], "ok")  # and only once

    def test_marker_continuity_survives_a_skip_during_a_table_change(self):
        self.start(self.both(5_000, discontinuity=0), marker=10)
        self.poll(self.skipped(6_000, discontinuity=0), marker=11)
        same = self.poll(self.both(7_000, discontinuity=0), marker=11, discover=True)
        self.assertEqual(counters(same, 1)["delta_state"], "ok")  # the marker shows nothing happened

    def test_a_marker_that_moved_is_found_after_the_skip(self):
        self.start(self.both(5_000, discontinuity=0), marker=10)
        self.poll(self.skipped(6_000, discontinuity=0), marker=11)
        moved = self.poll(self.both(7_000, discontinuity=1_040_000), marker=11, discover=True)
        self.assertEqual(counters(moved, 1)["delta_state"], "reset")

    def test_a_table_change_with_a_skipped_interface_that_had_a_marker_but_has_none_afterwards(self):
        self.start(self.both(5_000, discontinuity=0), marker=10)
        self.poll(self.skipped(6_000, discontinuity=0), marker=11)
        gone = self.poll(self.both(7_000), marker=11, discover=True)  # the marker vanished: no proof
        self.assertEqual(counters(gone, 1)["delta_state"], "reset")

    def test_a_missing_marker_row_during_a_table_change_is_not_continuity(self):
        # A partial walk: the marker rows of interface 1 are missing in the poll that sees the table change.
        self.start(self.both(5_000, discontinuity=0), marker=10)
        partial = self.poll(self.both(6_000, discontinuity=None), marker=11)
        self.assertEqual(counters(partial, 1)["delta_state"], "reset")


class StartupAfterAWrapTests(DiscontinuityTestCase):
    """The agent cannot know whether the device's ``sysUpTime`` wrapped before it first looked."""

    def test_a_discontinuity_after_startup_is_found_when_the_first_marker_predates_a_wrap(self):
        self.uptime = 100_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        result = counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=110_000)}, advance=300))
        self.assertEqual(result["delta_state"], "reset")  # 110,000 is after the first poll (100,000)

    def test_a_stable_marker_that_predates_a_wrap_gives_no_false_reset(self):
        self.uptime = 100_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        for step in range(1, 4):
            result = counters(self.poll({1: interface(1, in_octets64=5_000 + 1_000 * step, discontinuity=4_294_000_000)}))
            self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 1_000))

    def test_the_marker_that_predates_the_wrap_is_not_taken_as_a_proof_of_anything(self):
        # Unverifiable (it may be garbage): after a table change the interface is as without a marker.
        self.uptime = 100_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)}, marker=10)
        result = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)}, marker=11))
        self.assertEqual(result["delta_state"], "reset")

    def test_an_oversized_first_marker_followed_by_a_plausible_different_one_is_a_discontinuity(self):
        self.uptime = 100_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=3_000_000_000)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=5_100, discontinuity=90_000)}))["delta_state"], "reset")
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=5_200, discontinuity=90_000)}))["delta_state"], "ok")

    def test_an_observed_wrap_then_a_real_discontinuity(self):
        self.uptime = 4_294_950_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)}, uptime=12_704))["delta_state"], "ok")
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=40_000)}))["delta_state"], "reset")

    def test_a_missed_poll_around_the_wrap_is_neither_a_reboot_nor_a_false_reset(self):
        self.uptime = 4_294_950_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        self.fetcher.push(unreachable_poll())
        self.clock.advance(300)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.poller.poll()
        self.uptime = 42_704  # 600 s after the first poll: wrapped
        result = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)}, uptime=42_704, advance=300))
        self.assertEqual((result["delta_state"], result["interval_seconds"]), ("ok", 600.0))

    def test_invalid_and_unsupported_markers_after_startup_change_nothing(self):
        for value in (None, -5, 2**33):
            with self.subTest(marker=value):
                self.setUp()
                self.uptime = 100_000
                self.start({1: interface(1, in_octets64=5_000, discontinuity=value)})
                result = counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=value)}))
                self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 3_000))


def unreachable_poll():
    from agent.tests.snmp_helpers import unreachable

    return unreachable("timeout")


class CollectionConsistencyTests(DiscontinuityTestCase):
    """The walks take time and are not one snapshot: sysUpTime is read before and after them."""

    def test_a_counter_reset_during_the_collection_is_found_by_its_marker(self):
        # sysUpTime 1,030,000 before the walks; the counters reset at 1,030,040 and the walks return the new
        # ones; the marker says 1,030,040, which is after the first reading and before the last.
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(
            self.poll({1: interface(1, in_octets64=8_000, discontinuity=1_030_040)}, uptime=1_030_000, uptime_end=1_030_090)
        )
        self.assertEqual(result["delta_state"], "reset")

    def test_a_marker_after_the_last_reading_is_still_not_believed(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(
            self.poll({1: interface(1, in_octets64=8_000, discontinuity=1_030_500)}, uptime=1_030_000, uptime_end=1_030_090)
        )
        self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 3_000))  # ignored, as for any impossible value

    def test_a_reboot_during_the_collection_is_a_reboot_and_the_next_poll_starts_afresh(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        mixed = self.poll({1: interface(1, in_octets64=7_000, discontinuity=0)}, uptime=1_030_000, uptime_end=400)
        self.assertEqual(counters(mixed)["delta_state"], "reboot")
        self.assertNotIn("delta", counters(mixed))
        after = self.poll({1: interface(1, in_octets64=7_500, discontinuity=0)}, discover=True)
        self.assertEqual(counters(after)["delta_state"], "first")  # the mixed reading is no baseline

    def test_a_wrap_during_the_collection_is_not_claimed_to_be_a_reboot_and_has_no_delta(self):
        self.uptime = 4_294_900_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)})
        # 4,294,966,000 before the walks, 700 after, and the walks took 20 s: 1,996 ticks through the wrap.
        wrapped = self.poll(
            {1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)},
            uptime=4_294_966_000,
            uptime_end=700,
            took=20,
        )
        self.assertEqual(counters(wrapped)["delta_state"], "reset")  # see WrapOrRestartDuringTheCollectionTests
        self.assertEqual(counters(wrapped)["raw"]["in_octets"], 6_000)
        after = self.poll({1: interface(1, in_octets64=9_000, discontinuity=500)}, uptime=30_700, discover=True)
        self.assertEqual(counters(after)["delta_state"], "first")

    def test_a_wrap_during_the_collection_with_a_discontinuity_after_it_is_never_a_valid_delta(self):
        self.uptime = 4_294_900_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(
            self.poll({1: interface(1, in_octets64=9_000, discontinuity=300)}, uptime=4_294_966_000, uptime_end=700, took=20)
        )
        self.assertEqual(result["delta_state"], "reset")

    def test_a_failed_final_reading_leaves_no_valid_delta(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        unsure = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=0)}, uptime_end=None))
        self.assertEqual(unsure["delta_state"], "reset")
        self.assertEqual(unsure["raw"]["in_octets"], 6_000)  # the reading itself is kept
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=7_000, discontinuity=0)}))["delta_state"], "ok")

    def test_a_failed_final_reading_does_not_hide_a_reboot_the_next_poll_sees(self):
        self.start({1: interface(1, in_octets64=5_000)})
        self.poll({1: interface(1, in_octets64=6_000)}, uptime_end=None)
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=9_000)}, uptime=2_000))["delta_state"], "reboot")

    def test_a_consistent_collection_is_judged_as_before(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=0)}, uptime=1_030_000, uptime_end=1_030_090))
        self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 3_000))

    def test_a_fetcher_that_does_not_bracket_is_judged_as_one_that_failed_to(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=0)}, uptime_end=None))["delta_state"], "reset")


class WarningStateTests(DiscontinuityTestCase):
    def test_the_per_interface_warning_state_follows_the_interfaces_that_exist(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=-1)})
        with self.assertLogs("sentinel_agent", level="WARNING"):
            for index in range(2, 102):
                self.poller._rediscover = True
                self.poll({index: interface(index, in_octets64=5_000, discontinuity=-1)}, discover=True)
        self.assertLessEqual(len(self.poller._warned), 5)
        self.assertEqual(len(self.poller._marker_warned), 1)  # only the interface that is still there

    def test_an_active_interface_warns_once(self):
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            self.start({1: interface(1, in_octets64=5_000, discontinuity=-1)})
            for step in range(4):
                self.poll({1: interface(1, in_octets64=6_000 + step, discontinuity=-1)})
        self.assertEqual(len([m for m in logs.output if "ifCounterDiscontinuityTime" in m]), 1)

    def test_cleaning_the_warnings_does_not_touch_the_readings_or_the_detection(self):
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.start({1: interface(1, in_octets64=5_000, discontinuity=0), 2: interface(2, in_octets64=5_000, discontinuity=-1)})
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=0)})  # interface 2 vanishes
        result = counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=1_050_000)}, discover=True))
        self.assertEqual(result["delta_state"], "reset")


class StateKeptOnlyForInterfacesThatExistTests(DiscontinuityTestCase):
    def test_the_doubt_about_a_skipped_interface_goes_with_the_interface(self):
        both = {1: interface(1, in_octets64=5_000), 2: interface(2, in_octets64=5_000)}
        self.start(both, marker=10)
        self.poll({1: interface(1, in_octets64=6_000, admin=None), 2: interface(2, in_octets64=6_000)}, marker=11)
        self.assertEqual(self.poller._unproven, {1})
        self.poll({2: interface(2, in_octets64=7_000)}, marker=11)  # interface 1 is gone
        self.assertEqual(self.poller._unproven, set())

    def test_a_replaced_interface_may_be_warned_about_again(self):
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            self.start({1: interface(1, in_octets64=5_000, discontinuity=-1)})
            self.poller._rediscover = True
            replaced = dict(interface(1, in_octets64=9_000, discontinuity=-1), name="Po1", descr="Po1", type=161)
            self.poll({1: replaced}, discover=True)
        self.assertEqual(len([m for m in logs.output if "ifCounterDiscontinuityTime" in m]), 2)


class MoreCollectionConsistencyTests(DiscontinuityTestCase):
    def test_a_device_with_an_unusable_sysuptime_keeps_its_deltas(self):
        # Not a TimeTicks value: neither reading is used, so there is nothing to bracket the walks with.
        self.uptime = 2**32 + 5
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)})
        result = counters(self.poll({1: interface(1, in_octets64=6_000, discontinuity=0)}, uptime=2**32 + 7))
        self.assertEqual((result["delta_state"], result["delta"]["in_octets"]), ("ok", 1_000))

    def test_the_next_poll_is_compared_with_the_end_of_the_previous_collection(self):
        self.start({1: interface(1, in_octets64=5_000)})
        self.poll({1: interface(1, in_octets64=6_000)}, uptime=1_030_000, uptime_end=1_040_000)
        # Below the final reading of the poll before: the device cannot have been there.
        result = counters(self.poll({1: interface(1, in_octets64=7_000)}, uptime=1_035_000))
        self.assertEqual(result["delta_state"], "reboot")


class WrapBetweenPollsTests(DiscontinuityTestCase):
    def test_after_a_wrap_between_polls_a_marker_from_before_it_is_still_a_proof(self):
        self.uptime = 4_294_950_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=4_294_000_000)}, marker=10)
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=4_294_000_000)}, uptime=12_704, marker=10)
        after = self.poll({1: interface(1, in_octets64=7_000, discontinuity=4_294_000_000)}, marker=11)  # the table changed
        self.assertEqual(counters(after)["delta_state"], "ok")


MODULUS = 2**32


class WrapOrRestartDuringTheCollectionTests(DiscontinuityTestCase):
    """The tick counter reads lower at the end of the walks: it wrapped, or the device restarted.

    The span through the wrap (from the first reading to the end, 100 ticks a second) is compared with the
    time the collection took on the monotonic clock. A span longer than that cannot be a wrap: a restart.
    A span that fits is what a wrap looks like, but also a restart close to the wrap, and nothing
    observable tells them apart: no delta is vouched for.
    """

    def start_near_the_wrap(self, before=MODULUS - 10_000):
        self.uptime = before - 30_000  # one poll interval earlier
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)}, marker=0)

    def collect(self, *, before, end, took, **kwargs):
        return self.poll(
            {1: interface(1, in_octets64=8_000, discontinuity=0)}, uptime=before, uptime_end=end, took=took, marker=0, **kwargs
        )

    def test_a_restart_during_a_one_second_collection_is_not_mistaken_for_a_wrap(self):
        self.start_near_the_wrap()  # the baseline; the poll interval is 300 s
        poll = self.collect(before=MODULUS - 10_000, end=50, took=1)  # 10,050 ticks (100 s) through the wrap in 1 s
        self.assertEqual(counters(poll)["delta_state"], "reboot")
        self.assertNotIn("delta", counters(poll))
        self.assertEqual(counters(poll)["raw"]["in_octets"], 8_000)

    def test_a_wrap_that_fits_the_duration_is_not_vouched_for_either(self):
        self.start_near_the_wrap(before=MODULUS - 50)
        poll = self.collect(before=MODULUS - 50, end=50, took=1)  # 100 ticks through the wrap in 1 s
        self.assertEqual(counters(poll)["delta_state"], "reset")  # not "ok" and not claimed to be a restart
        self.assertEqual(counters(poll)["raw"]["in_octets"], 8_000)
        self.assertEqual(counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=0)}, marker=0))["delta_state"], "first")

    def test_the_duration_limit_is_the_measured_time_plus_one_percent_plus_a_second(self):
        for span, expected in ((1_110, "reset"), (1_111, "reboot")):  # 10 s measured: 1,000 + 10 + 100 ticks
            with self.subTest(span=span):
                self.setUp()
                self.start_near_the_wrap(before=MODULUS - 1_000)
                poll = self.collect(before=MODULUS - 1_000, end=span - 1_000, took=10)
                self.assertEqual(counters(poll)["delta_state"], expected)

    def test_delayed_responses_widen_what_fits(self):
        for end, expected in ((4_050 - 4_000, "reset"), (10_050 - 4_000, "reboot")):  # a 60 s collection
            with self.subTest(end=end):
                self.setUp()
                self.start_near_the_wrap(before=MODULUS - 4_000)
                poll = self.collect(before=MODULUS - 4_000, end=end, took=60)
                self.assertEqual(counters(poll)["delta_state"], expected)

    def test_the_wall_clock_is_not_what_is_measured(self):
        self.start_near_the_wrap()
        poll = self.collect(before=MODULUS - 10_000, end=50, took=1, wall_jump=timedelta(days=1))
        self.assertEqual(counters(poll)["delta_state"], "reboot")
        self.setUp()
        self.start_near_the_wrap(before=MODULUS - 50)
        poll = self.collect(before=MODULUS - 50, end=50, took=1, wall_jump=timedelta(days=-1))
        self.assertEqual(counters(poll)["delta_state"], "reset")

    def test_without_the_final_reading_nothing_is_vouched_for(self):
        self.start_near_the_wrap()
        poll = self.collect(before=MODULUS - 10_000, end=None, took=1)
        self.assertEqual(counters(poll)["delta_state"], "reset")

    def test_a_restart_after_a_wrap_that_was_seen_is_still_a_restart(self):
        self.uptime = MODULUS - 20_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=MODULUS - 40_000)}, marker=0)
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=MODULUS - 40_000)}, uptime=10_000, marker=0)  # seen to wrap
        poll = self.poll(
            {1: interface(1, in_octets64=7_000, discontinuity=0)}, uptime=40_000, uptime_end=30, took=1, marker=0
        )
        self.assertEqual(counters(poll)["delta_state"], "reboot")
        # The new epoch: a marker above its uptime is not believed again.
        again = self.poll({1: interface(1, in_octets64=7_500, discontinuity=MODULUS - 40_000)}, discover=True, marker=0)
        self.assertEqual(counters(again)["delta_state"], "first")

    def test_nothing_changes_for_a_collection_whose_uptime_did_not_go_back(self):
        self.start_near_the_wrap()
        poll = self.collect(before=MODULUS - 10_000, end=MODULUS - 9_900, took=1)
        self.assertEqual((counters(poll)["delta_state"], counters(poll)["delta"]["in_octets"]), ("ok", 3_000))


class DiscoveryInterruptedByARestartTests(DiscontinuityTestCase):
    """Metadata read before a restart and after it is not one inventory."""

    def named(self, name, **kwargs):
        return {1: dict(interface(1, **{"in_octets64": 5_000, **kwargs}), name=name, descr=name), 2: interface(2)}

    def setUp(self):
        super().setUp()
        self.start(self.named("old-port"))

    def discovery_with_a_restart(self, name="replacement-port", **kwargs):
        self.poller._rediscover = True
        kwargs.setdefault("uptime_end", 400)
        return self.poll(self.named(name, in_octets64=None), uptime=1_030_000, discover=True, took=1, **kwargs)

    def test_the_interrupted_discovery_is_not_a_complete_inventory(self):
        poll = self.discovery_with_a_restart()
        self.assertNotIn("interfaces_complete", poll)
        self.assertNotIn("system", poll)
        self.assertEqual(counters(poll)["delta_state"], "reboot")

    def test_the_mixed_identity_is_not_adopted_and_discovery_is_not_over(self):
        self.discovery_with_a_restart()
        self.assertEqual(self.poller._interfaces[1].name, "old-port")
        self.assertTrue(self.poller._rediscover)

    def test_the_next_poll_discovers_afresh_and_adopts_what_it_finds(self):
        self.discovery_with_a_restart()
        poll = self.poll(self.named("replacement-port"), uptime=500, discover=True)
        self.assertTrue(self.fetcher.plans[-1].discover)
        self.assertEqual((poll["interfaces_complete"], poll["interfaces"][0]["name"]), (True, "replacement-port"))
        self.assertFalse(self.poller._rediscover)
        self.assertEqual(counters(poll)["delta_state"], "first")  # the identity changed, so no delta across it

    def test_a_restart_during_the_following_discovery_too_keeps_it_pending(self):
        self.discovery_with_a_restart()
        self.discovery_with_a_restart("another-port")
        self.assertTrue(self.poller._rediscover)
        self.assertEqual(self.poller._interfaces[1].name, "old-port")

    def test_a_failed_followup_discovery_keeps_it_pending(self):
        self.discovery_with_a_restart()
        self.fetcher.push(unreachable_poll())
        self.clock.advance(300)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.poller.poll()
        self.assertTrue(self.poller._rediscover)
        poll = self.poll(self.named("replacement-port"), uptime=900, discover=True)
        self.assertTrue(poll["interfaces_complete"])
        self.assertFalse(self.poller._rediscover)

    def test_a_restart_during_an_ordinary_poll_asks_for_discovery(self):
        self.poll(self.named("old-port", in_octets64=6_000), uptime=1_030_000, uptime_end=400, took=1)
        self.assertTrue(self.poller._rediscover)

    def test_an_ambiguous_wrap_during_discovery_is_treated_the_same_way(self):
        self.uptime = MODULUS - 40_000
        self.setUp()
        self.uptime = MODULUS - 40_000
        self.poller._rediscover = True
        poll = self.poll(self.named("replacement-port", in_octets64=6_000), uptime=MODULUS - 50, uptime_end=50, discover=True, took=1)
        self.assertNotIn("interfaces_complete", poll)
        self.assertTrue(self.poller._rediscover)

    def test_a_discovery_after_a_restart_between_polls_is_complete(self):
        self.poller._rediscover = True
        poll = self.poll(self.named("replacement-port"), uptime=500, discover=True)
        self.assertTrue(poll["interfaces_complete"])

    def test_the_very_first_discovery_interrupted_publishes_no_interface_at_all(self):
        # Nothing trusted is known: names read around a restart are provisional, and the poll cannot carry
        # a reading without saying which interface it is, so it carries none.
        poller = self.new_poller()
        self.fetcher.push(
            lambda plan: (setattr(self.clock, "now", self.clock.now + 1), raw_data(self.named("mixed-port"), uptime=900_000, uptime_end=300, discover=True))[1]
        )
        poll = poller.poll()
        self.assertEqual(poll["interfaces"], [])
        for key in ("interfaces_complete", "system"):
            self.assertNotIn(key, poll)
        self.assertNotIn("mixed-port", str(poll))
        self.assertTrue(poller._rediscover)
        self.assertIsNone(poller._interfaces)


class RawDeviceDataConstructionTests(unittest.TestCase):
    def test_the_arguments_that_were_positional_still_are(self):
        from agent.snmp_fetch import RawDeviceData

        columns = {"oper": {1: 1}}
        data = RawDeviceData(12.5, 1_000_000, 10, {"name": "sw"}, columns)
        self.assertEqual(
            (data.response_ms, data.sys_uptime_ticks, data.if_table_last_change, data.system, data.columns),
            (12.5, 1_000_000, 10, {"name": "sw"}, columns),
        )
        self.assertIsNone(data.sys_uptime_end_ticks)

    def test_the_final_uptime_is_one_more_optional_field(self):
        from agent.snmp_fetch import RawDeviceData

        data = RawDeviceData(12.5, 1_000_000, sys_uptime_end_ticks=1_000_050)
        self.assertEqual((data.sys_uptime_end_ticks, data.system, data.columns), (1_000_050, {}, {}))
        self.assertEqual(RawDeviceData(1.0, 5, 6, {}, {}, 7).sys_uptime_end_ticks, 7)

    def test_a_fetcher_without_the_final_uptime_is_judged_as_one_that_failed_to_read_it(self):
        from agent.snmp_fetch import RawDeviceData
        from agent.tests.snmp_helpers import raw_data as build

        clock = Clock()
        full = build({1: interface(1, in_octets64=5_000)}, discover=True)
        legacy = RawDeviceData(full.response_ms, full.sys_uptime_ticks, full.if_table_last_change, full.system, full.columns)
        fetcher = FakeFetcher(legacy)
        poller = DevicePoller(device(), v3(), fetcher, monotonic=clock.monotonic, utcnow=clock.utcnow, new_id=ids())
        poller.poll()
        later = build({1: interface(1, in_octets64=6_000)}, uptime=1_030_000)
        fetcher.push(RawDeviceData(later.response_ms, later.sys_uptime_ticks, later.if_table_last_change, later.system, later.columns))
        clock.advance(300)
        poll = poller.poll()
        self.assertEqual(counters(poll)["delta_state"], "reset")
        self.assertEqual(counters(poll)["raw"]["in_octets"], 6_000)


class WhatAnInterruptedCollectionLeavesBehindTests(DiscontinuityTestCase):
    BIG = 4_294_000_000

    def table_change_with_the_same_big_marker(self, uptime):
        """Two polls with the same marker above the uptime, the second after a table change."""
        self.poll({1: interface(1, in_octets64=7_000, discontinuity=self.BIG)}, uptime=uptime + 30_000, discover=True, marker=10)
        after = self.poll({1: interface(1, in_octets64=8_000, discontinuity=self.BIG)}, uptime=uptime + 60_000, marker=11)
        return counters(after)

    def test_an_ambiguous_wrap_is_not_remembered_as_one(self):
        self.uptime = MODULUS - 40_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=self.BIG)}, marker=10)
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=self.BIG)}, uptime=MODULUS - 50, uptime_end=50, took=1, marker=10)
        # No wrap is assumed: a marker above the uptime proves nothing, so the table change is not excused.
        self.assertEqual(self.table_change_with_the_same_big_marker(50)["delta_state"], "reset")

    def test_a_restart_during_the_collection_ends_the_epoch_in_which_a_wrap_was_seen(self):
        self.uptime = MODULUS - 20_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=self.BIG)}, marker=10)
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=self.BIG)}, uptime=10_000, marker=10)  # seen to wrap
        self.poll({1: interface(1, in_octets64=7_000, discontinuity=0)}, uptime=40_000, uptime_end=30, took=1, marker=10)
        self.assertEqual(self.table_change_with_the_same_big_marker(30)["delta_state"], "reset")

    def test_an_ambiguous_wrap_during_an_ordinary_poll_asks_for_discovery(self):
        self.uptime = MODULUS - 40_000
        self.start({1: interface(1, in_octets64=5_000)}, marker=10)
        self.assertFalse(self.poller._rediscover)
        self.poll({1: interface(1, in_octets64=6_000)}, uptime=MODULUS - 50, uptime_end=50, took=1, marker=10)
        self.assertTrue(self.poller._rediscover)


class StaleWrapKnowledgeTests(DiscontinuityTestCase):
    """What is known about the uptime epoch ends with the epoch: after a transition that may have been a restart
    nothing that assumed the same epoch survives."""

    BIG = 4_294_000_000

    def after_a_seen_wrap_and_another_cycle(self):
        """A wrap observed between polls (the flag is set), then a later cycle of the tick counter, then a baseline."""
        self.uptime = MODULUS - 20_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=self.BIG)}, marker=10)
        self.poll({1: interface(1, in_octets64=5_500, discontinuity=self.BIG)}, uptime=10_000, marker=10)
        self.assertTrue(self.poller._uptime_wrapped)
        self.poll({1: interface(1, in_octets64=6_000, discontinuity=self.BIG)}, uptime=MODULUS - 30_050, marker=10)

    def ambiguous(self, in_octets=7_000):
        return self.poll(
            {1: interface(1, in_octets64=in_octets, discontinuity=self.BIG)}, uptime=MODULUS - 50, uptime_end=50, took=1, marker=10
        )

    def table_change_with_the_same_big_marker(self, uptime):
        self.poll({1: interface(1, in_octets64=8_000, discontinuity=self.BIG)}, uptime=uptime, discover=True, marker=10)
        return counters(self.poll({1: interface(1, in_octets64=9_000, discontinuity=self.BIG)}, uptime=uptime + 30_000, marker=11))

    def test_an_old_wrap_does_not_excuse_a_marker_after_an_ambiguous_transition(self):
        self.after_a_seen_wrap_and_another_cycle()
        result = counters(self.ambiguous())
        self.assertEqual(result["delta_state"], "reset")
        self.assertEqual(result["raw"]["in_octets"], 7_000)
        self.assertFalse(self.poller._uptime_wrapped)
        self.assertEqual(self.table_change_with_the_same_big_marker(30_050)["delta_state"], "reset")

    def test_the_same_through_every_step_of_the_reproduction(self):
        self.after_a_seen_wrap_and_another_cycle()
        self.ambiguous()
        self.assertFalse(self.poller._uptime_wrapped)
        self.assertEqual(self.poller._previous, {})  # no baseline survives
        self.assertTrue(self.poller._rediscover)
        baseline = counters(self.poll({1: interface(1, in_octets64=8_000, discontinuity=self.BIG)}, uptime=30_050, discover=True, marker=10))
        self.assertEqual(baseline["delta_state"], "first")
        self.assertEqual(baseline["raw"]["in_octets"], 8_000)

    def test_repeated_ambiguous_transitions_keep_nothing_of_the_epoch(self):
        self.after_a_seen_wrap_and_another_cycle()
        self.ambiguous(7_000)
        self.poll({1: interface(1, in_octets64=8_000, discontinuity=self.BIG)}, uptime=MODULUS - 30_050, discover=True, marker=10)
        second = counters(self.ambiguous(9_000))
        self.assertEqual((second["delta_state"], second["raw"]["in_octets"]), ("reset", 9_000))
        self.assertFalse(self.poller._uptime_wrapped)
        self.assertEqual(self.table_change_with_the_same_big_marker(30_050)["delta_state"], "reset")

    def test_a_confirmed_restart_ends_the_epoch_too(self):
        self.after_a_seen_wrap_and_another_cycle()
        poll = self.poll({1: interface(1, in_octets64=7_000, discontinuity=0)}, uptime=MODULUS - 10_000, uptime_end=30, took=1, marker=10)
        self.assertEqual(counters(poll)["delta_state"], "reboot")
        self.assertFalse(self.poller._uptime_wrapped)
        self.assertEqual(self.table_change_with_the_same_big_marker(30_030)["delta_state"], "reset")

    def test_a_restart_between_polls_ends_the_epoch_too(self):
        self.after_a_seen_wrap_and_another_cycle()
        self.poll({1: interface(1, in_octets64=7_000, discontinuity=0)}, uptime=500, marker=10)
        self.assertFalse(self.poller._uptime_wrapped)

    def test_within_a_proven_epoch_the_marker_still_proves_continuity(self):
        self.uptime = MODULUS - 20_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=self.BIG)}, marker=10)
        self.poll({1: interface(1, in_octets64=5_500, discontinuity=self.BIG)}, uptime=10_000, marker=10)  # the wrap, seen
        after = self.poll({1: interface(1, in_octets64=6_500, discontinuity=self.BIG)}, uptime=40_000, marker=11)  # table change
        self.assertEqual((counters(after)["delta_state"], counters(after)["delta"]["in_octets"]), ("ok", 1_000))

    def test_the_count_of_markers_that_moved_does_not_cross_an_ambiguous_transition(self):
        self.uptime = MODULUS - 200_000
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0)}, marker=10)
        for step in (1, 2):
            self.poll({1: interface(1, in_octets64=5_000 + step, discontinuity=self.uptime + 30_000 - 100)}, marker=10)
        self.assertEqual(self.poller._marker_streak[1], 2)
        self.poll({1: interface(1, in_octets64=7_000, discontinuity=0)}, uptime=MODULUS - 50, uptime_end=50, took=1, marker=10)
        self.assertEqual(self.poller._marker_streak, {})


class ProvisionalIdentityTests(DiscontinuityTestCase):
    def named(self, name):
        return {1: dict(interface(1, in_octets64=5_000), name=name, descr=name), 2: interface(2)}

    def interrupted_first_discovery(self, name):
        self.fetcher.push(
            lambda plan: (setattr(self.clock, "now", self.clock.now + 1), raw_data(self.named(name), uptime=900_000, uptime_end=300, discover=True))[1]
        )
        self.clock.advance(300)
        return self.poller.poll()

    def test_nothing_of_an_interrupted_first_discovery_is_published(self):
        poll = self.interrupted_first_discovery("mixed-port")
        self.assertEqual((poll["interfaces"], poll["reachable"]), ([], True))
        self.assertNotIn("mixed-port", str(poll))
        for key in ("interfaces_complete", "system"):
            self.assertNotIn(key, poll)
        self.assertEqual(poll["sys_uptime_ticks"], 900_000)  # the liveness and uptime are still reported

    def test_repeated_interrupted_discoveries_publish_nothing_each_time(self):
        for name in ("mixed-1", "mixed-2", "mixed-3"):
            poll = self.interrupted_first_discovery(name)
            self.assertEqual(poll["interfaces"], [])
            self.assertTrue(self.poller._rediscover)
        self.assertIsNone(self.poller._interfaces)

    def test_a_failed_followup_leaves_it_pending_and_a_complete_one_publishes_the_trusted_identity(self):
        self.interrupted_first_discovery("mixed-port")
        self.fetcher.push(unreachable_poll())
        self.clock.advance(300)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.poller.poll()
        self.assertTrue(self.poller._rediscover)
        self.fetcher.push(raw_data(self.named("trusted-port"), uptime=500, discover=True))
        self.clock.advance(300)
        poll = self.poller.poll()
        self.assertEqual((poll["interfaces_complete"], poll["interfaces"][0]["name"]), (True, "trusted-port"))
        self.assertFalse(self.poller._rediscover)

    def test_a_poller_that_already_knows_its_interfaces_keeps_publishing_what_it_trusted(self):
        self.start(self.named("old-port"))
        self.poller._rediscover = True
        self.fetcher.push(
            lambda plan: (setattr(self.clock, "now", self.clock.now + 1), raw_data(self.named("mixed-port"), uptime=1_030_000, uptime_end=300, discover=True))[1]
        )
        self.clock.advance(300)
        poll = self.poller.poll()
        self.assertEqual(sorted(e["name"] for e in poll["interfaces"]), ["Gi0/2", "old-port"])
        self.assertNotIn("mixed-port", str(poll))


class RestartClearsWhatCountedMarkersTests(DiscontinuityTestCase):
    def test_a_restart_clears_the_marker_counts_of_interfaces_it_could_not_read_too(self):
        self.start({1: interface(1, in_octets64=5_000, discontinuity=0), 2: interface(2)}, marker=10)
        for step in (1, 2):
            self.poll({1: interface(1, in_octets64=5_000 + step, discontinuity=self.uptime + 30_000 - 100), 2: interface(2)}, marker=10)
        self.assertEqual(self.poller._marker_streak[1], 2)
        self.poll({1: interface(1, in_octets64=7_000, admin=None), 2: interface(2)}, uptime=3_000, marker=10)  # restart; 1 skipped
        self.assertEqual(self.poller._marker_streak, {})
