import copy
import math
import uuid

from django.test import TestCase, override_settings

from apps.snmp.models import MAX_BIGINT
from apps.snmp.reports import (
    MAX_INTERFACES_PER_POLL,
    MAX_INTERFACES_PER_REPORT,
    MAX_POLLS_PER_REPORT,
    SnmpValidationError,
    validate_snmp_payload,
)
from apps.snmp.tests.helpers import (
    counters,
    interface,
    make_agent,
    make_device,
    minutes_ago,
    poll,
    report,
)

MAX_U32 = 2**32 - 1


class ValidationTestCase(TestCase):
    def setUp(self):
        self.agent, _token = make_agent()
        self.device = make_device(self.agent)

    def validate(self, *polls):
        return validate_snmp_payload(report(list(polls)), agent=self.agent)

    def assert_accepted(self, payload):
        result = self.validate(payload)
        self.assertEqual([r.reason for r in result.rejections], [])
        self.assertEqual(len(result.polls), 1)
        return result.polls[0]

    def assert_rejected(self, payload, reason, *, retryable=False):
        """Data problems are permanent; problems that depend on server state or
        the clock (device not created/assigned/enabled yet, a timestamp the
        server's clock has not reached) are retryable, so the agent keeps the poll."""
        result = self.validate(payload)
        self.assertEqual(result.polls, ())
        self.assertEqual(len(result.rejections), 1, result.polls)
        rejection = result.rejections[0]
        self.assertIn(reason, rejection.reason)
        self.assertEqual(rejection.retryable, retryable)
        return rejection


class EnvelopeTests(ValidationTestCase):
    def test_section_must_be_an_object_with_version_1_and_a_list_of_polls(self):
        for raw, message in (
            (None, "snmp must be an object"),
            ([], "snmp must be an object"),
            ("x", "snmp must be an object"),
            ({"polls": []}, "unsupported snmp version"),
            ({"version": 2, "polls": []}, "unsupported snmp version"),
            ({"version": "1", "polls": []}, "unsupported snmp version"),
            ({"version": True, "polls": []}, "unsupported snmp version"),
            ({"version": 1.0, "polls": []}, "unsupported snmp version"),
            ({"version": 1}, "polls must be a list"),
            ({"version": 1, "polls": {}}, "polls must be a list"),
        ):
            with self.subTest(raw=raw):
                with self.assertRaisesMessage(SnmpValidationError, message):
                    validate_snmp_payload(raw, agent=self.agent)

    def test_empty_report_is_valid(self):
        result = validate_snmp_payload({"version": 1, "polls": []}, agent=self.agent)
        self.assertEqual((result.polls, result.rejections), ((), ()))

    def test_too_many_polls_reject_the_whole_section(self):
        polls = [poll(self.device, minutes=i + 1) for i in range(MAX_POLLS_PER_REPORT + 1)]
        with self.assertRaisesMessage(SnmpValidationError, "polls exceeds maximum"):
            self.validate(*polls)
        self.assertEqual(len(self.validate(*polls[:MAX_POLLS_PER_REPORT]).polls), MAX_POLLS_PER_REPORT)

    def test_too_many_interfaces_in_one_report_reject_the_whole_section(self):
        per_poll = MAX_INTERFACES_PER_POLL
        polls = [
            poll(self.device, [interface(i, with_counters=False) for i in range(1, per_poll + 1)], minutes=m)
            for m in range(1, MAX_INTERFACES_PER_REPORT // per_poll + 2)
        ]
        with self.assertRaisesMessage(SnmpValidationError, "interfaces exceeds maximum of"):
            self.validate(*polls)

    def test_a_poll_that_is_not_an_object_is_rejected_without_an_id(self):
        result = self.validate("nope", 5, None)
        self.assertEqual([r.poll_id for r in result.rejections], [None, None, None])
        self.assertTrue(all("must be an object" in r.reason for r in result.rejections))


class PollValidationTests(ValidationTestCase):
    def test_valid_poll_is_accepted_and_normalized(self):
        validated = self.assert_accepted(poll(self.device))
        self.assertEqual(validated.device_id, self.device.pk)
        self.assertTrue(validated.reachable)
        self.assertEqual(validated.system.name, "core-sw-1")
        self.assertEqual(len(validated.interfaces), 2)
        self.assertIsNotNone(validated.interfaces[0].counters)
        self.assertIsNone(validated.interfaces[1].counters)
        self.assertFalse(validated.interfaces_complete)

    def test_ids_must_be_uuids(self):
        for field in ("poll_id", "device_id"):
            for value in (None, "", "not-a-uuid", 5, "12345678-1234-1234-1234-12345678901z"):
                with self.subTest(field=field, value=value):
                    payload = poll(self.device)
                    payload[field] = value
                    self.assert_rejected(payload, f"{field} must be a UUID string")

    def test_rejection_echoes_only_a_parseable_poll_id(self):
        payload = poll(self.device, measured_at="garbage")
        rejection = self.assert_rejected(payload, "measured_at")
        self.assertEqual(rejection.poll_id, payload["poll_id"])
        payload = poll(self.device, poll_id="x")
        payload["poll_id"] = "<script>"
        self.assertIsNone(self.assert_rejected(payload, "poll_id").poll_id)

    def test_device_ownership_and_state_are_checked(self):
        other_agent, _token = make_agent("other")
        foreign = make_device(other_agent, "foreign")
        unconfigured = make_device(self.agent, "no-config", configured=False)
        disabled = make_device(self.agent, "off", enabled=False)
        unassigned = make_device(None, "loose")
        generic = "unknown device_id or device not assigned to this agent"
        cases = (
            (poll(foreign), generic),
            (poll(unassigned), generic),
            (poll(self.device, device_id=str(uuid.uuid4())), generic),
            (poll(unconfigured), "no SNMP configuration"),
            (poll(disabled), "device is disabled"),
        )
        for payload, message in cases:
            with self.subTest(message=message, device=payload["device_id"]):
                # An operator can still create, assign, enable or configure the
                # device: the agent must keep the poll and resend it.
                self.assert_rejected(payload, message, retryable=True)

    def test_an_agent_cannot_tell_foreign_devices_from_missing_ones(self):
        other_agent, _token = make_agent("other")
        foreign = make_device(other_agent, "foreign")
        reasons = {
            self.validate(poll(foreign)).rejections[0].reason,
            self.validate(poll(self.device, device_id=str(uuid.uuid4()))).rejections[0].reason,
        }
        self.assertEqual(len(reasons), 1)

    def test_timestamps(self):
        for value in (None, "", "yesterday", "2026-13-45T10:00:00", 12345):
            with self.subTest(value=value):
                self.assert_rejected(poll(self.device, measured_at=value), "measured_at must be an ISO-8601 timestamp")
        # The server's clock catches up with a slightly-ahead agent clock.
        self.assert_rejected(poll(self.device, measured_at=minutes_ago(-30)), "too far in the future", retryable=True)
        self.assert_rejected(poll(self.device, measured_at="0001-01-01T00:30:00+01:00"), "measured_at")
        naive = minutes_ago(5).split("+")[0]
        self.assert_accepted(poll(self.device, measured_at=naive))

    @override_settings(SENTINEL_SNMP_MAX_AGE_DAYS=8, SENTINEL_SNMP_RETENTION_DAYS=30)
    def test_delayed_polls_are_accepted_inside_the_window_only(self):
        self.assert_accepted(poll(self.device, measured_at=minutes_ago(7 * 24 * 60)))
        self.assert_rejected(poll(self.device, measured_at=minutes_ago(9 * 24 * 60)), "older than the accepted history window")

    @override_settings(SENTINEL_SNMP_MAX_AGE_DAYS=60, SENTINEL_SNMP_RETENTION_DAYS=30)
    def test_window_never_exceeds_retention(self):
        self.assert_rejected(poll(self.device, measured_at=minutes_ago(31 * 24 * 60)), "older than the accepted history window")

    def test_reachability_fields(self):
        self.assert_rejected(poll(self.device, reachable="yes"), "reachable must be a boolean")
        self.assert_rejected(poll(self.device, reachable=None), "reachable must be a boolean")
        self.assert_rejected(poll(self.device, error="timeout"), "a reachable device must not set error")
        self.assert_rejected(poll(self.device, reachable=False, error="exploded"), "error is invalid")
        self.assert_rejected(poll(self.device, reachable=False, error=5), "error is invalid")
        self.assert_accepted(poll(self.device, reachable=False, error=""))
        for error in ("timeout", "unreachable", "auth_failure", "dns_failure", "protocol_error", "unsupported", "unknown"):
            with self.subTest(error=error):
                self.assert_accepted(poll(self.device, reachable=False, error=error))

    def test_an_unreachable_device_reports_nothing_else(self):
        down = poll(self.device, reachable=False)
        for key, value in (
            ("system", {"name": "x"}),
            ("sys_uptime_ticks", 5),
            ("interfaces", [interface(1)]),
        ):
            with self.subTest(key=key):
                self.assert_rejected({**down, key: value}, "unreachable device cannot report")
        self.assert_rejected({**down, "interfaces_complete": True}, "interfaces_complete requires a reachable device")

    def test_numbers_must_be_finite_and_in_range(self):
        for key, bad in (
            ("response_ms", -1),
            ("response_ms", 600_001),
            ("response_ms", math.nan),
            ("response_ms", math.inf),
            ("response_ms", True),
            ("response_ms", "12"),
            ("sys_uptime_ticks", -1),
            ("sys_uptime_ticks", 2**32),
            ("sys_uptime_ticks", 1.5),
            ("sys_uptime_ticks", True),
        ):
            with self.subTest(key=key, value=bad):
                self.assert_rejected(poll(self.device, **{key: bad}), key)
        self.assert_accepted(poll(self.device, response_ms=0, sys_uptime_ticks=2**32 - 1))
        self.assert_accepted(poll(self.device, response_ms=None, sys_uptime_ticks=None))

    def test_system_information_is_cleaned_not_rejected(self):
        payload = poll(self.device)
        payload["system"] = {
            "name": "  core\tsw\n1  ",
            "descr": "Cisco IOS\r\nSoftware\x00 17.9\x1b[31m" + "x" * 2000,
            "object_id": "1.3.6.1.4.1.9.1.2504",
        }
        system = self.assert_accepted(payload).system
        self.assertEqual(system.name, "core sw 1")
        self.assertTrue(system.descr.startswith("Cisco IOS Software 17.9 [31m"))
        self.assertEqual(len(system.descr), 1024)
        self.assertNotIn("\n", system.descr)

    def test_system_object_id_and_types_are_checked(self):
        for bad in ("1", "1.3.x", ".1.3", "1.3.", "abc", "1.3.6.1." + "9" * 300, 5, "", "1.3.6.1.4.1.9\n", "1.3.6\r\n"):
            with self.subTest(object_id=bad):
                payload = poll(self.device)
                payload["system"] = {"object_id": bad}
                self.assert_rejected(payload, "system.object_id must be a dotted OID")
        for bad_system in ("text", [], 5):
            payload = poll(self.device)
            payload["system"] = bad_system
            self.assert_rejected(payload, "system must be an object")
        payload = poll(self.device)
        payload["system"] = {"name": 5}
        self.assert_rejected(payload, "system.name must be a string")

    def test_duplicates_inside_a_report_are_rejected_individually(self):
        first = poll(self.device, minutes=5)
        same_id = {**poll(self.device, minutes=4), "poll_id": first["poll_id"]}
        same_time = {**poll(self.device), "measured_at": first["measured_at"]}
        result = self.validate(first, same_id, same_time)
        self.assertEqual([p.poll_id for p in result.polls], [uuid.UUID(first["poll_id"])])
        self.assertEqual(
            [r.reason for r in result.rejections],
            ["duplicate poll_id in report", "duplicate poll for this device and time in report"],
        )

    def test_one_bad_poll_does_not_affect_the_others(self):
        good = poll(self.device, minutes=3)
        bad = poll(self.device, minutes=2, reachable="maybe")
        other = poll(self.device, minutes=1)
        result = self.validate(good, bad, other)
        self.assertEqual(len(result.polls), 2)
        self.assertEqual([r.poll_id for r in result.rejections], [bad["poll_id"]])


class InterfaceValidationTests(ValidationTestCase):
    def poll_with(self, entry):
        return poll(self.device, [entry])

    def test_valid_interface_values(self):
        entry = interface(7, "ge-0/0/7", oper=7, admin=2, speed=None)
        entry.update(descr="", alias="uplink to dc2", if_type=117)
        validated = self.assert_accepted(self.poll_with(entry)).interfaces[0]
        self.assertEqual((validated.if_index, validated.name, validated.oper_status, validated.admin_status), (7, "ge-0/0/7", 7, 2))
        self.assertIsNone(validated.speed_bps)

    def test_interface_field_rules(self):
        cases = (
            ({"if_index": 0}, "if_index"),
            ({"if_index": -1}, "if_index"),
            ({"if_index": 2**31}, "if_index"),
            ({"if_index": "1"}, "if_index"),
            ({"if_index": True}, "if_index"),
            ({"if_index": None}, "if_index"),
            ({"name": 5}, "name must be a string"),
            ({"admin_status": 0}, "admin_status"),
            ({"admin_status": 4}, "admin_status"),
            ({"admin_status": None}, "admin_status"),
            ({"oper_status": 0}, "oper_status"),
            ({"oper_status": 8}, "oper_status"),
            ({"oper_status": "up"}, "oper_status"),
            ({"speed_bps": -1}, "speed_bps"),
            ({"speed_bps": 10**15 + 1}, "speed_bps"),
            ({"speed_bps": 1.5}, "speed_bps"),
            ({"if_type": -1}, "if_type"),
            ({"if_type": 65536}, "if_type"),
        )
        for overrides, message in cases:
            with self.subTest(**overrides):
                self.assert_rejected(self.poll_with({**interface(3), **overrides}), message)

    def test_interface_must_be_an_object_and_indexes_unique_within_a_poll(self):
        self.assert_rejected(poll(self.device, ["eth0"]), "each interface must be an object")
        self.assert_rejected(poll(self.device, [interface(4), interface(4, "again")]), "duplicate if_index 4 in poll")
        self.assert_rejected(poll(self.device, {"if_index": 1}), "interfaces must be a list")
        self.assert_rejected(
            poll(self.device, [interface(i, with_counters=False) for i in range(1, MAX_INTERFACES_PER_POLL + 2)]),
            "interfaces exceeds maximum",
        )

    def test_a_blank_interface_name_falls_back_instead_of_losing_the_poll(self):
        cases = (
            ({"name": "", "descr": "GigabitEthernet0/3"}, "GigabitEthernet0/3"),
            ({"name": "   ", "descr": "uplink"}, "uplink"),
            ({"name": None, "descr": ""}, "if3"),
            ({"name": "\x00\x01", "descr": "\n"}, "if3"),
        )
        for overrides, expected in cases:
            with self.subTest(**overrides):
                validated = self.assert_accepted(self.poll_with({**interface(3), **overrides}))
                self.assertEqual(validated.interfaces[0].name, expected)

    def test_rejection_names_the_interface(self):
        rejection = self.assert_rejected(self.poll_with(interface(12, oper_status=99)), "interface 12")
        self.assertIn("oper_status", rejection.reason)

    def test_text_fields_are_cleaned_and_truncated(self):
        entry = interface(1, name="Gi0/1\n", descr="x" * 400, alias="line1\nline2")
        validated = self.assert_accepted(self.poll_with(entry)).interfaces[0]
        self.assertEqual(validated.name, "Gi0/1")
        self.assertEqual(len(validated.descr), 255)
        self.assertEqual(validated.alias, "line1 line2")

    def test_interfaces_complete_must_be_a_boolean(self):
        self.assert_rejected(poll(self.device, interfaces_complete="yes"), "interfaces_complete must be a boolean")
        self.assertTrue(self.assert_accepted(poll(self.device, interfaces_complete=True)).interfaces_complete)


class CounterValidationTests(ValidationTestCase):
    def poll_with(self, block):
        return poll(self.device, [interface(1, counters=block)])

    def test_valid_counter_blocks(self):
        for state in ("ok", "speed_changed"):
            with self.subTest(state=state):
                validated = self.assert_accepted(self.poll_with(counters(state))).interfaces[0].counters
                self.assertEqual(validated.delta_state, state)
                self.assertEqual(validated.raw["in_octets"], 1_000_000)
                self.assertEqual(validated.delta["out_octets"], 600_000)
        for state in ("first", "reboot", "reset", "gap"):
            with self.subTest(state=state):
                validated = self.assert_accepted(self.poll_with(counters(state, interval=None))).interfaces[0].counters
                self.assertTrue(all(value is None for value in validated.delta.values()))
                self.assertIsNone(validated.interval_seconds)

    def test_counter_values_up_to_the_storage_limit_are_accepted(self):
        raw = {**counters()["raw"], "in_octets": MAX_BIGINT, "out_octets": MAX_BIGINT - 1}
        delta = {**counters()["delta"], "in_octets": MAX_BIGINT}
        self.assert_accepted(self.poll_with(counters(raw=raw, delta=delta)))

    def test_counter_values_beyond_the_storage_limit_are_rejected(self):
        raw = {**counters()["raw"], "in_octets": MAX_BIGINT + 1}
        self.assert_rejected(self.poll_with(counters(raw=raw, delta={"in_octets": 1})), "raw in_octets")

    def test_counter_width_limits_the_values(self):
        too_big_for_32 = {**counters()["raw"], "in_octets": MAX_U32 + 1}
        self.assert_rejected(self.poll_with(counters(bits=32, raw=too_big_for_32, delta={})), "raw in_octets")
        self.assert_accepted(self.poll_with(counters(bits=32, raw={**too_big_for_32, "in_octets": MAX_U32}, delta={"in_octets": MAX_U32})))
        # Error and discard counters are always 32-bit, even next to 64-bit octets.
        for name in ("in_errors", "out_errors", "in_discards", "out_discards"):
            with self.subTest(counter=name):
                raw = {**counters()["raw"], name: MAX_U32 + 1}
                self.assert_rejected(self.poll_with(counters(bits=64, raw=raw, delta={})), f"raw {name}")

    def test_missing_counters_are_null(self):
        raw = {"in_octets": 10, "out_octets": 20}
        validated = self.assert_accepted(
            self.poll_with(counters(raw=raw, delta={"in_octets": 1, "out_octets": 2}))
        ).interfaces[0].counters
        self.assertEqual(validated.raw["in_errors"], None)
        self.assertEqual(validated.delta["out_discards"], None)

    def test_counter_block_rules(self):
        base = counters()
        cases = (
            ("not an object", "oops", "counters must be an object"),
            ("bits missing", {**base, "octets_bits": None}, "octets_bits"),
            ("bits 16", {**base, "octets_bits": 16}, "octets_bits"),
            ("bits 48", {**base, "octets_bits": 48}, "octets_bits must be 32 or 64"),
            ("state missing", {**base, "delta_state": None}, "delta_state is invalid"),
            ("state unknown", {**base, "delta_state": "fine"}, "delta_state is invalid"),
            ("raw missing", {**base, "raw": None}, "counters.raw must be an object"),
            ("raw negative", {**base, "raw": {**base["raw"], "in_octets": -1}}, "raw in_octets"),
            ("raw float", {**base, "raw": {**base["raw"], "in_octets": 1.5}}, "raw in_octets"),
            ("raw bool", {**base, "raw": {**base["raw"], "in_octets": True}}, "raw in_octets"),
            ("raw nan", {**base, "raw": {**base["raw"], "in_octets": math.nan}}, "raw in_octets"),
            ("interval missing", {**base, "interval_seconds": None}, "interval_seconds is required"),
            ("interval zero", {**base, "interval_seconds": 0}, "interval_seconds must be greater than 0"),
            ("interval negative", {**base, "interval_seconds": -5}, "interval_seconds"),
            ("interval huge", {**base, "interval_seconds": 8 * 86400}, "interval_seconds"),
            ("interval nan", {**base, "interval_seconds": math.nan}, "interval_seconds"),
            ("delta missing", {**base, "delta": None}, "counters.delta must be an object"),
            ("delta negative", {**base, "delta": {**base["delta"], "in_octets": -1}}, "delta in_octets"),
            ("delta without raw", {**base, "raw": {"in_octets": 1}, "delta": {"out_octets": 5}}, "delta out_octets requires the raw counter"),
            ("delta beyond 32-bit", counters(bits=32, delta={"in_octets": MAX_U32 + 1}), "delta in_octets"),
        )
        for label, block, message in cases:
            with self.subTest(case=label):
                self.assert_rejected(self.poll_with(block), message)

    def test_deltas_are_refused_when_the_state_says_they_are_not_valid(self):
        for state in ("first", "reboot", "reset", "gap"):
            with self.subTest(state=state):
                block = {**counters(state, interval=None), "delta": {"in_octets": 5}}
                self.assert_rejected(self.poll_with(block), f"deltas must be empty when delta_state is {state}")
        block = {**counters("first", interval=None), "delta": "five"}
        self.assert_rejected(self.poll_with(block), "counters.delta must be an object")

    def test_a_zero_interval_is_unknown_not_an_error_when_deltas_are_not_valid(self):
        for state in ("first", "reboot", "reset", "gap"):
            with self.subTest(state=state):
                block = counters(state, interval=0)
                validated = self.assert_accepted(self.poll_with(block)).interfaces[0].counters
                self.assertIsNone(validated.interval_seconds)
        # ... but valid deltas still need a real interval.
        self.assert_rejected(self.poll_with(counters("ok", interval=0)), "interval_seconds must be greater than 0")
        # and a negative or non-finite one is never accepted
        for bad in (-1, math.nan, 8 * 86400):
            with self.subTest(interval=bad):
                self.assert_rejected(self.poll_with(counters("first", interval=bad)), "interval_seconds")

    def test_an_interface_without_counters_is_inventory_only(self):
        validated = self.assert_accepted(poll(self.device, [interface(9, with_counters=False)])).interfaces[0]
        self.assertIsNone(validated.counters)

    def test_validation_does_not_modify_the_input(self):
        payload = poll(self.device, [interface(1), interface(2)])
        before = copy.deepcopy(payload)
        self.validate(payload)
        self.assertEqual(payload, before)
