import unittest

from agent.snmp_deltas import (
    COUNTER32_MODULUS,
    MAX_RAW_COUNTER32,
    MAX_RAW_COUNTER64,
    CounterSnapshot,
    bounded_raw,
    compute_delta,
    uptime_went_backwards,
)

GIGABIT = 1_000_000_000
GAP = 3.5 * 300


def snap(at, *, bits=64, speed=GIGABIT, **raw):
    values = {name: None for name in ("in_octets", "out_octets", "in_errors", "out_errors", "in_discards", "out_discards")}
    values.update(raw)
    return CounterSnapshot(taken_at=at, octets_bits=bits, speed_bps=speed, raw=values)


def delta(previous, current, *, rebooted=False, gap=GAP):
    return compute_delta(previous, current, rebooted=rebooted, max_gap_seconds=gap)


class ValidDeltaTests(unittest.TestCase):
    def test_first_sample_has_no_deltas_and_no_interval(self):
        result = delta(None, snap(0, in_octets=5))
        self.assertEqual((result.state, result.interval_seconds, result.delta), ("first", None, None))

    def test_ok_delta_and_interval(self):
        result = delta(
            snap(0, in_octets=1000, out_octets=500, in_errors=1, out_errors=0, in_discards=2, out_discards=3),
            snap(300.2, in_octets=4000, out_octets=900, in_errors=1, out_errors=4, in_discards=2, out_discards=10),
        )
        self.assertEqual(result.state, "ok")
        self.assertEqual(result.interval_seconds, 300.2)
        self.assertEqual(
            result.delta,
            {"in_octets": 3000, "out_octets": 400, "in_errors": 0, "out_errors": 4, "in_discards": 0, "out_discards": 7},
        )

    def test_unchanged_counters_give_zero_deltas(self):
        result = delta(snap(0, in_octets=7, out_octets=7), snap(300, in_octets=7, out_octets=7))
        self.assertEqual(result.state, "ok")
        self.assertEqual(result.delta["in_octets"], 0)

    def test_a_counter_missing_on_either_side_has_no_delta_but_the_others_do(self):
        result = delta(snap(0, in_octets=1, out_octets=None), snap(300, in_octets=3, out_octets=9))
        self.assertEqual(result.state, "ok")
        self.assertEqual((result.delta["in_octets"], result.delta["out_octets"]), (2, None))

    def test_nothing_countable_is_treated_as_a_first_sample(self):
        result = delta(snap(0), snap(300))
        self.assertEqual((result.state, result.delta), ("first", None))

    def test_speed_change_keeps_the_deltas_but_says_so(self):
        result = delta(
            snap(0, speed=100_000_000, in_octets=1),
            snap(300, speed=GIGABIT, in_octets=11),
        )
        self.assertEqual((result.state, result.delta["in_octets"]), ("speed_changed", 10))

    def test_unknown_speed_on_one_side_is_not_a_speed_change(self):
        result = delta(snap(0, speed=None, in_octets=1), snap(300, speed=GIGABIT, in_octets=2))
        self.assertEqual(result.state, "ok")


class WrapAndResetTests(unittest.TestCase):
    def test_32_bit_octet_counter_wrap_is_accounted_for(self):
        before = COUNTER32_MODULUS - 1000
        result = delta(snap(0, bits=32, in_octets=before), snap(300, bits=32, in_octets=2000))
        self.assertEqual((result.state, result.delta["in_octets"]), ("ok", 3000))

    def test_32_bit_error_counter_wraps_even_when_octets_are_64_bit(self):
        result = delta(
            snap(0, bits=64, in_octets=1, in_errors=COUNTER32_MODULUS - 5),
            snap(300, bits=64, in_octets=2, in_errors=10),
        )
        self.assertEqual((result.state, result.delta["in_errors"]), ("ok", 15))

    def test_a_64_bit_counter_going_backwards_is_a_reset(self):
        result = delta(snap(0, in_octets=10**12), snap(300, in_octets=5))
        self.assertEqual((result.state, result.delta), ("reset", None))
        self.assertEqual(result.interval_seconds, 300)

    def test_a_busy_32_bit_link_wrapping_is_not_a_reset(self):
        # 100 Mbit/s link at 70% load for 300 s: 2.6 GB, more than half the counter range.
        before = COUNTER32_MODULUS - 1_000_000_000
        result = delta(
            snap(0, bits=32, speed=100_000_000, in_octets=before),
            snap(300, bits=32, speed=100_000_000, in_octets=1_600_000_000),
        )
        self.assertEqual((result.state, result.delta["in_octets"]), ("ok", 2_600_000_000))

    def test_a_decrease_on_a_slow_link_is_a_reset_because_the_wrap_would_not_fit(self):
        # 5_000 -> 100 would mean 4.29 GB in 300 s: 114 Mbit/s on a 10 Mbit/s link.
        result = delta(
            snap(0, bits=32, speed=10_000_000, in_octets=5_000),
            snap(300, bits=32, speed=10_000_000, in_octets=100),
        )
        self.assertEqual(result.state, "reset")

    def test_without_a_speed_a_decrease_is_a_wrap_only_below_half_the_range(self):
        small = delta(
            snap(0, bits=32, speed=None, in_octets=COUNTER32_MODULUS - 500_000_000),
            snap(300, bits=32, speed=None, in_octets=1_000_000_000),
        )
        self.assertEqual((small.state, small.delta["in_octets"]), ("ok", 1_500_000_000))
        large = delta(
            snap(0, bits=32, speed=None, in_octets=5_000),
            snap(300, bits=32, speed=None, in_octets=100),
        )
        self.assertEqual(large.state, "reset")

    def test_error_counters_that_decrease_are_resets_even_on_a_fast_link(self):
        result = delta(
            snap(0, bits=32, speed=GIGABIT, in_octets=1, in_errors=100),
            snap(300, bits=32, speed=GIGABIT, in_octets=2, in_errors=5),
        )
        self.assertEqual(result.state, "reset")

    def test_a_cleared_octet_counter_on_a_fast_32_bit_link_looks_like_a_wrap(self):
        # The documented limit: indistinguishable from a wrap (a restart is caught by uptime).
        result = delta(
            snap(0, bits=32, speed=GIGABIT, in_octets=3_500_000_000),
            snap(300, bits=32, speed=GIGABIT, in_octets=1_000),
        )
        self.assertEqual(result.state, "ok")

    def test_a_wrap_faster_than_the_link_is_a_reset(self):
        # Plausible by size (< 2 GiB) but 1.5 GB in 10 s is 1.2 Gbit/s on a 100 Mbit/s link.
        before = COUNTER32_MODULUS - 500_000_000
        result = delta(
            snap(0, bits=32, speed=100_000_000, in_octets=before),
            snap(10, bits=32, speed=100_000_000, in_octets=1_000_000_000),
        )
        self.assertEqual(result.state, "reset")

    def test_the_speed_check_is_skipped_when_the_speed_is_unknown(self):
        before = COUNTER32_MODULUS - 500_000_000
        result = delta(
            snap(0, bits=32, speed=None, in_octets=before),
            snap(10, bits=32, speed=None, in_octets=1_000_000_000),
        )
        self.assertEqual(result.state, "ok")

    def test_one_implausible_counter_voids_every_delta_of_the_interface(self):
        result = delta(
            snap(0, in_octets=100, out_octets=10**12),
            snap(300, in_octets=200, out_octets=5),
        )
        self.assertEqual((result.state, result.delta), ("reset", None))

    def test_octet_width_change_between_polls_is_a_reset(self):
        result = delta(snap(0, bits=32, in_octets=5), snap(300, bits=64, in_octets=9))
        self.assertEqual(result.state, "reset")


class ReloadAndGapTests(unittest.TestCase):
    def test_reboot_wins_over_everything_else(self):
        result = delta(snap(0, in_octets=100), snap(300, in_octets=5), rebooted=True)
        self.assertEqual((result.state, result.delta), ("reboot", None))
        self.assertEqual(result.interval_seconds, 300)

    def test_a_previous_sample_that_is_too_old_is_a_gap(self):
        result = delta(snap(0, in_octets=1), snap(GAP + 1, in_octets=2))
        self.assertEqual((result.state, result.delta), ("gap", None))

    def test_exactly_at_the_limit_is_still_valid(self):
        self.assertEqual(delta(snap(0, in_octets=1), snap(GAP, in_octets=2)).state, "ok")

    def test_an_interval_the_server_would_reject_is_left_out(self):
        week = 7 * 24 * 3600
        for rebooted in (False, True):
            with self.subTest(rebooted=rebooted):
                result = delta(
                    snap(0, in_octets=1), snap(week + 1, in_octets=2), rebooted=rebooted, gap=GAP
                )
                self.assertEqual(result.state, "reboot" if rebooted else "gap")
                self.assertIsNone(result.interval_seconds)
        result = delta(snap(0, in_octets=1), snap(week, in_octets=2), rebooted=True)
        self.assertEqual(result.interval_seconds, week)

    def test_a_clock_that_did_not_advance_is_a_gap_without_interval(self):
        result = delta(snap(5, in_octets=1), snap(5, in_octets=2))
        self.assertEqual((result.state, result.interval_seconds), ("gap", None))
        result = delta(snap(5, in_octets=1), snap(4, in_octets=2))
        self.assertEqual((result.state, result.interval_seconds), ("gap", None))


class UptimeTests(unittest.TestCase):
    def test_a_decrease_is_a_restart(self):
        self.assertTrue(uptime_went_backwards(500_000, 1_000, 300))

    def test_growth_and_unknown_values_are_not(self):
        self.assertFalse(uptime_went_backwards(1_000, 31_000, 300))
        self.assertFalse(uptime_went_backwards(1_000, 1_000, 300))
        self.assertFalse(uptime_went_backwards(None, 5, 300))
        self.assertFalse(uptime_went_backwards(5, None, 300))

    def test_the_32_bit_tick_counter_wrapping_is_not_a_restart(self):
        modulus = 2**32
        before = modulus - 10_000  # 100 s before the wrap
        after = 20_000  # 300 s later (30_000 ticks): 200 s past the wrap
        self.assertFalse(uptime_went_backwards(before, after, 300))

    def test_a_restart_shortly_after_a_wrap_boundary_is_still_a_restart(self):
        modulus = 2**32
        self.assertTrue(uptime_went_backwards(modulus - 10_000, 50, 300))


class BoundsTests(unittest.TestCase):
    def test_values_the_server_would_reject_become_none(self):
        self.assertEqual(bounded_raw("in_octets", 5, 64), 5)
        self.assertIsNone(bounded_raw("in_octets", MAX_RAW_COUNTER64 + 1, 64))
        self.assertIsNone(bounded_raw("in_octets", MAX_RAW_COUNTER32 + 1, 32))
        self.assertIsNone(bounded_raw("in_errors", MAX_RAW_COUNTER32 + 1, 64))  # always 32-bit
        self.assertIsNone(bounded_raw("in_octets", -1, 64))
        self.assertIsNone(bounded_raw("in_octets", None, 64))
        self.assertEqual(bounded_raw("in_octets", MAX_RAW_COUNTER64, 64), MAX_RAW_COUNTER64)


if __name__ == "__main__":
    unittest.main()
