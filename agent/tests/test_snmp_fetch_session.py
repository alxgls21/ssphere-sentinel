"""Unit tests for the pysnmp session helpers of ``agent.snmp_fetch``.

Everything that parses what a device sends (``_Session.walk``, ``_Session.get``,
``_value`` and the column plan of ``PysnmpFetcher._read_interfaces``) was only
exercised through the snmpsim integration tests, which are skipped when snmpsim
is not installed. These tests use small fakes that mimic the pysnmp objects by
class name (the fetcher dispatches on ``type(value).__name__``), so they need no
SNMP library.
"""

import asyncio
import unittest
from unittest.mock import patch

from agent import snmp_fetch
from agent import snmp_oids as oids
from agent.snmp_fetch import (
    MAX_IF_INDEX,
    MAX_WALK_ROWS,
    FetchPlan,
    PysnmpFetcher,
    RawDeviceData,
    SnmpFetchError,
    _Session,
    _value,
)
from agent.snmp_payload import ERROR_AUTH_FAILURE, ERROR_PROTOCOL, ERROR_TIMEOUT

# -- fakes named like the pysnmp types the fetcher recognises --------------------------


class OctetString:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def asOctets(self) -> bytes:  # noqa: N802 - pysnmp's name
        return self._data


class DisplayString(OctetString):
    pass


class ObjectIdentifier:
    def __init__(self, text: str) -> None:
        self._text = text

    def __str__(self) -> str:
        return self._text


class Integer32(int):
    pass


class Counter64(int):
    pass


class TimeTicks(int):
    pass


class IpAddress:
    """Not an integer: only ``prettyPrint`` gives something useful."""

    def prettyPrint(self) -> str:  # noqa: N802
        return "192.0.2.1"


class NoSuchInstance:
    pass


class NoSuchObject:
    pass


class EndOfMibView:
    pass


class RequestTimedOut(Exception):
    pass


class _Status:
    def __init__(self, text: str) -> None:
        self._text = text

    def __bool__(self) -> bool:
        return True

    def prettyPrint(self) -> str:  # noqa: N802
        return self._text


class FakeWalker:
    """Async-iterable that yields ``(error, status, index, binds)`` and records ``aclose``."""

    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._responses:
            raise StopAsyncIteration
        return self._responses.pop(0)

    async def aclose(self) -> None:
        self.closed = True


class FakeApi:
    def __init__(self, walker=None, get_result=None) -> None:
        self.walker = walker
        self.get_result = get_result

    def ObjectType(self, identity):  # noqa: N802
        return identity

    def ObjectIdentity(self, oid):  # noqa: N802
        return oid

    def bulk_walk_cmd(self, *_args, **_kwargs):
        return self.walker

    async def get_cmd(self, *_args, **_kwargs):
        return self.get_result


def _session(api: FakeApi, secrets=()) -> _Session:
    return _Session(api, None, None, None, None, secrets)


OPER = oids.COLUMNS["oper"]


def _row(column_oid: str, suffix, value):
    return (f"{column_oid}.{suffix}", value)


class ValueConversionTests(unittest.TestCase):
    def test_octet_strings_lose_control_characters_and_surrounding_space(self):
        text = _value(OctetString(b"Gi0/1\x00\x07 uplink\n"))
        self.assertEqual(text, "Gi0/1  uplink")

    def test_c1_control_characters_are_removed_like_c0_ones(self):
        # U+0080..U+009F (NEL, CSI, ...) encoded as UTF-8: they used to reach the payload and the log.
        text = _value(OctetString("Gi0/1\u0085\u009b31m uplink\u0080".encode("utf-8")))
        self.assertEqual(text, "Gi0/1 31m uplink")
        # The characters right after the C1 range are text, not controls: kept.
        self.assertEqual(_value(OctetString("café ©".encode("utf-8"))), "café ©")

    def test_invalid_utf8_is_replaced_not_raised(self):
        self.assertEqual(_value(DisplayString(b"caf\xc3\xa9 \xff")), "café �")

    def test_object_identifiers_become_dotted_strings(self):
        self.assertEqual(_value(ObjectIdentifier("1.3.6.1.4.1.9.1.1")), "1.3.6.1.4.1.9.1.1")

    def test_numbers_become_plain_ints_even_beyond_63_bits(self):
        value = _value(Counter64(2**64 - 1))
        self.assertIs(type(value), int)
        self.assertEqual(value, 2**64 - 1)

    def test_values_that_are_not_numbers_use_their_pretty_print(self):
        self.assertEqual(_value(IpAddress()), "192.0.2.1")

    def test_unknown_objects_fall_back_to_str(self):
        class Odd:
            def __str__(self) -> str:
                return "odd"

        self.assertEqual(_value(Odd()), "odd")

    def test_long_text_is_cut_to_the_longest_text_the_collector_keeps(self):
        # A5: one value can carry about 64 KB; only the first 1,024 characters are kept (MAX_SYS_DESCR,
        # the collector's largest limit), whatever type the device sends it as.
        class Opaque:  # not a number: kept as its pretty print (hex)
            def prettyPrint(self) -> str:  # noqa: N802
                return "0x" + "ab" * 40_000

        self.assertEqual(_value(OctetString(b"a" * 70_000)), "a" * 1024)
        self.assertEqual(_value(ObjectIdentifier("1." * 3_000 + "1")), ("1." * 3_000)[:1024])
        self.assertEqual(_value(Opaque()), ("0x" + "ab" * 40_000)[:1024])

    def test_cutting_long_text_changes_nothing_the_collector_sends(self):
        from agent.snmp_collector import MAX_ALIAS, MAX_NAME, MAX_SYS_DESCR, MAX_SYS_NAME, _text

        full = "xé\U0001f600 " * 1_500  # 6,000 characters of 1, 2 and 4 bytes in UTF-8
        kept = _value(OctetString(full.encode("utf-8")))
        for limit in (MAX_ALIAS, MAX_NAME, MAX_SYS_NAME, MAX_SYS_DESCR):
            with self.subTest(limit=limit):
                self.assertEqual(_text(kept, limit), _text(full.strip(), limit))


class WalkTests(unittest.TestCase):
    def _walk(self, responses, *, max_rows=100, secrets=()):
        walker = FakeWalker(responses)
        session = _session(FakeApi(walker=walker), secrets)
        return walker, lambda: asyncio.run(session.walk(OPER, 25, max_rows))

    def test_only_valid_rows_of_the_column_are_kept(self):
        binds = [
            _row(OPER, 1, Integer32(1)),
            _row(OPER, 2, Integer32(2)),
            _row(OPER, 0, Integer32(9)),  # ifIndex 0 is not valid
            _row(OPER, MAX_IF_INDEX, Integer32(7)),  # the largest valid one
            _row(OPER, MAX_IF_INDEX + 1, Integer32(7)),  # one too many
            _row(OPER, "3.4", Integer32(5)),  # not a plain index
            _row(OPER, "x", Integer32(5)),
            _row(OPER, "-1", Integer32(5)),
            (f"{OPER}0.5", Integer32(5)),  # another column that starts with the same digits
            _row(oids.COLUMNS["admin"], 1, Integer32(1)),  # the walk ran past its column
            _row(OPER, 5, NoSuchInstance()),
            _row(OPER, 6, EndOfMibView()),
            _row(OPER, 7, NoSuchObject()),
        ]
        walker, run = self._walk([(None, 0, 0, binds)])
        self.assertEqual(run(), {1: 1, 2: 2, MAX_IF_INDEX: 7})
        self.assertTrue(walker.closed)

    def test_rows_of_several_responses_are_combined(self):
        walker, run = self._walk(
            [
                (None, 0, 0, [_row(OPER, 1, Integer32(1))]),
                (None, 0, 0, [_row(OPER, 2, Integer32(2)), _row(OPER, 3, Integer32(7))]),
            ]
        )
        self.assertEqual(run(), {1: 1, 2: 2, 3: 7})

    def test_an_empty_walk_is_an_empty_table(self):
        walker, run = self._walk([])
        self.assertEqual(run(), {})
        self.assertTrue(walker.closed)

    def test_a_table_over_the_row_limit_is_a_protocol_error_and_the_walk_is_closed(self):
        binds = [_row(OPER, index, Integer32(1)) for index in range(1, 4)]
        walker, run = self._walk([(None, 0, 0, binds)], max_rows=2)
        with self.assertRaises(SnmpFetchError) as ctx:
            run()
        self.assertEqual(ctx.exception.category, ERROR_PROTOCOL)
        self.assertTrue(walker.closed)

    def test_an_error_in_the_middle_of_a_walk_is_classified_scrubbed_and_closes_the_walk(self):
        secret = "s3cretcommunity"
        walker, run = self._walk(
            [
                (None, 0, 0, [_row(OPER, 1, Integer32(1))]),
                (RequestTimedOut(f"no answer from {secret}"), 0, 0, []),
            ],
            secrets=(secret,),
        )
        with self.assertRaises(SnmpFetchError) as ctx:
            run()
        self.assertEqual(ctx.exception.category, ERROR_TIMEOUT)
        self.assertNotIn(secret, str(ctx.exception))
        self.assertTrue(walker.closed)

    def test_an_error_status_is_reported_as_a_fetch_error(self):
        for text, category in (("noAccess", ERROR_AUTH_FAILURE), ("tooBig", ERROR_PROTOCOL)):
            with self.subTest(status=text):
                walker, run = self._walk([(None, _Status(text), 0, [])])
                with self.assertRaises(SnmpFetchError) as ctx:
                    run()
                self.assertEqual(ctx.exception.category, category)
                self.assertTrue(walker.closed)

    # -- the text one poll keeps is bounded (A5) ------------------------------------

    def test_a_poll_that_sends_more_text_than_a_poll_keeps_is_a_protocol_error(self):
        rows = [_row(OPER, index, OctetString(b"x" * 1_000)) for index in range(1, 11)]  # 10,000 characters
        with patch("agent.snmp_fetch.MAX_POLL_TEXT_CHARS", 5_000, create=True):
            walker, run = self._walk([(None, 0, 0, rows)])
            with self.assertRaises(SnmpFetchError) as ctx:
                run()
        self.assertEqual(ctx.exception.category, ERROR_PROTOCOL)
        self.assertTrue(walker.closed)

    def test_the_text_budget_is_for_the_whole_poll_not_for_each_walk(self):
        rows = [_row(OPER, index, OctetString(b"x" * 1_000)) for index in range(1, 4)]  # 3,000 per walk
        with patch("agent.snmp_fetch.MAX_POLL_TEXT_CHARS", 5_000, create=True):
            api = FakeApi(walker=FakeWalker([(None, 0, 0, rows)]))
            session = _session(api)
            self.assertEqual(len(asyncio.run(session.walk(OPER, 25, 100))), 3)
            api.walker = FakeWalker([(None, 0, 0, rows)])
            with self.assertRaises(SnmpFetchError) as ctx:
                asyncio.run(session.walk(OPER, 25, 100))
        self.assertEqual(ctx.exception.category, ERROR_PROTOCOL)

    def test_a_device_within_the_if_mib_sizes_cannot_reach_the_text_budget(self):
        # ifName and ifDescr are DisplayString (255 characters at most), ifAlias 64; the system group adds
        # sysName and sysDescr (255 each) and sysObjectID.
        largest_legitimate_poll = MAX_WALK_ROWS * (255 + 255 + 64) + 255 + 255 + 1024
        self.assertGreater(getattr(snmp_fetch, "MAX_POLL_TEXT_CHARS", 0), largest_legitimate_poll)


class GetTests(unittest.TestCase):
    def test_exception_values_are_left_out_and_the_others_converted(self):
        binds = [
            (oids.SYS_UPTIME, TimeTicks(123456)),
            (oids.SYS_NAME, NoSuchObject()),
            (oids.SYS_DESCR, OctetString(b"core switch")),
            (oids.IF_TABLE_LAST_CHANGE, NoSuchInstance()),
        ]
        session = _session(FakeApi(get_result=(None, 0, 0, binds)))
        values = asyncio.run(session.get([oids.SYS_UPTIME, oids.SYS_NAME]))
        self.assertEqual(values, {oids.SYS_UPTIME: 123456, oids.SYS_DESCR: "core switch"})

    def test_an_error_indication_raises(self):
        session = _session(FakeApi(get_result=(RequestTimedOut("x"), 0, 0, [])))
        with self.assertRaises(SnmpFetchError) as ctx:
            asyncio.run(session.get([oids.SYS_UPTIME]))
        self.assertEqual(ctx.exception.category, ERROR_TIMEOUT)


class FakeColumnSession:
    """Answers ``walk`` from a ``{column name: rows}`` mapping and records the order."""

    def __init__(self, columns) -> None:
        self._by_oid = {oids.COLUMNS[name]: rows for name, rows in columns.items()}
        self.walked: list[str] = []

    async def walk(self, column_oid, _repetitions, _max_rows):
        self.walked.append(column_oid)
        return dict(self._by_oid.get(column_oid, {}))


def _names(session: FakeColumnSession) -> list[str]:
    by_oid = {oid: name for name, oid in oids.COLUMNS.items()}
    return [by_oid[oid] for oid in session.walked]


class ReadInterfacesPlanTests(unittest.TestCase):
    def _read(self, columns, *, discover=False):
        session = FakeColumnSession(columns)
        data = RawDeviceData(response_ms=1.0, sys_uptime_ticks=1)
        asyncio.run(PysnmpFetcher()._read_interfaces(session, FetchPlan(discover), data))
        return session, data

    def _complete(self):
        both = {1: 1, 2: 2}
        return {
            "oper": {1: 1, 2: 1},
            "in_octets64": both,
            "out_octets64": both,
            "high_speed": {1: 1000, 2: 1000},
        }

    def test_a_device_with_64_bit_counters_and_high_speed_reads_exactly_the_poll_columns(self):
        session, data = self._read(self._complete())
        self.assertEqual(_names(session), list(oids.POLL_COLUMNS))
        self.assertEqual(set(data.columns), set(oids.POLL_COLUMNS))

    def test_a_discovery_poll_adds_the_descriptive_columns_after_the_poll_columns(self):
        session, _data = self._read(self._complete(), discover=True)
        self.assertEqual(_names(session), list(oids.POLL_COLUMNS) + list(oids.DISCOVERY_COLUMNS))

    def test_one_interface_without_64_bit_counters_makes_the_32_bit_columns_necessary(self):
        columns = self._complete()
        columns["in_octets64"] = {1: 1}  # interface 2 has none
        session, data = self._read(columns)
        self.assertEqual(_names(session)[-2:], list(oids.FALLBACK_OCTET_COLUMNS))
        self.assertNotIn("speed", _names(session))
        self.assertIn("in_octets32", data.columns)

    def test_a_missing_or_zero_high_speed_makes_if_speed_necessary(self):
        columns = self._complete()
        columns["high_speed"] = {1: 1000, 2: 0}
        session, _data = self._read(columns)
        self.assertEqual(_names(session)[-1], oids.FALLBACK_SPEED_COLUMN)
        self.assertNotIn("in_octets32", _names(session))

    def test_without_an_interface_table_nothing_else_is_walked(self):
        session, data = self._read({"oper": {}}, discover=True)
        self.assertEqual(_names(session), ["oper"])
        self.assertEqual(set(data.columns), {"oper"})


if __name__ == "__main__":
    unittest.main()
