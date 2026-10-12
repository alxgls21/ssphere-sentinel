"""The parts of the fetcher that need no SNMP library."""

import socket
import threading
import time
import unittest

from agent.snmp_fetch import (
    MAX_MESSAGE_LENGTH,
    SnmpFetchCancelled,
    SnmpFetchError,
    _raise_for,
    _scrub,
    classify_exception,
    resolve_address,
)
from agent.tests.snmp_helpers import SECRET


class ResolveAddressTests(unittest.TestCase):
    def test_ip_literals_are_returned_as_they_are_without_any_lookup(self):
        def forbidden(*_args, **_kwargs):
            raise AssertionError("no lookup for a literal")

        for literal in ("192.0.2.10", "2001:db8::1", "::1"):
            self.assertEqual(resolve_address(literal, 1, getaddrinfo=forbidden), literal)

    def test_a_name_is_resolved_to_an_ipv4_address(self):
        seen = {}

        def lookup(host, port, **kwargs):
            seen.update(host=host, **kwargs)
            return [(socket.AF_INET, socket.SOCK_DGRAM, 17, "", ("192.0.2.77", 0))]

        self.assertEqual(resolve_address("switch.example", 1, getaddrinfo=lookup), "192.0.2.77")
        self.assertEqual((seen["host"], seen["family"]), ("switch.example", socket.AF_INET))

    def test_a_resolver_failure_is_a_dns_failure_without_the_name(self):
        def lookup(*_args, **_kwargs):
            raise socket.gaierror(8, "nodename nor servname provided")

        with self.assertRaises(SnmpFetchError) as caught:
            resolve_address("no-such-host.invalid", 1, getaddrinfo=lookup)
        self.assertEqual(caught.exception.category, "dns_failure")
        self.assertNotIn("no-such-host", str(caught.exception))

    def test_a_hanging_resolver_cannot_outlive_the_deadline(self):
        release = threading.Event()
        self.addCleanup(release.set)
        started = time.monotonic()
        with self.assertRaises(SnmpFetchError) as caught:
            resolve_address("slow.example", 0.4, getaddrinfo=lambda *a, **k: release.wait(30))
        self.assertEqual(caught.exception.category, "dns_failure")
        self.assertIn("timed out", str(caught.exception))
        self.assertLess(time.monotonic() - started, 2)

    def test_a_hanging_resolver_does_not_survive_cancellation(self):
        release = threading.Event()
        self.addCleanup(release.set)
        cancel = threading.Event()
        threading.Timer(0.2, cancel.set).start()
        started = time.monotonic()
        with self.assertRaises(SnmpFetchCancelled):
            resolve_address("slow.example", 30, cancel, getaddrinfo=lambda *a, **k: release.wait(30))
        self.assertLess(time.monotonic() - started, 2)

    def test_the_helper_thread_is_a_daemon_so_it_cannot_delay_exit(self):
        release = threading.Event()
        self.addCleanup(release.set)
        with self.assertRaises(SnmpFetchError):
            resolve_address("slow.example", 0.2, getaddrinfo=lambda *a, **k: release.wait(30))
        helpers = [t for t in threading.enumerate() if t.name == "sentinel-resolve"]
        self.assertTrue(helpers and all(t.daemon for t in helpers))


class ScrubTests(unittest.TestCase):
    def test_secrets_are_removed_before_the_message_is_shortened(self):
        # A secret that straddles the length limit must not survive as a fragment.
        message = "x" * (MAX_MESSAGE_LENGTH - 5) + SECRET + " tail"
        cleaned = _scrub(message, (SECRET,))
        self.assertNotIn(SECRET, cleaned)
        self.assertNotIn(SECRET[:6], cleaned.replace("x", ""))
        self.assertLessEqual(len(cleaned), MAX_MESSAGE_LENGTH)

    def test_classification_does_not_truncate_so_scrubbing_can_see_everything(self):
        long_text = "y" * 500 + SECRET
        _category, message = classify_exception(RuntimeError(long_text))
        self.assertIn(SECRET, message)  # raw here, scrubbed by every caller

    def test_library_errors_are_scrubbed_where_they_become_fetch_errors(self):
        class Indication(Exception):
            pass

        with self.assertRaises(SnmpFetchError) as caught:
            _raise_for(Indication(f"bad {SECRET}"), None, (SECRET,))
        self.assertNotIn(SECRET, str(caught.exception))

        with self.assertRaises(SnmpFetchError) as caught:
            _raise_for(None, f"error-{SECRET}", (SECRET,))
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertEqual(caught.exception.category, "protocol_error")

    def test_authorization_errors_are_authentication_failures(self):
        with self.assertRaises(SnmpFetchError) as caught:
            _raise_for(None, "authorizationError", ())
        self.assertEqual(caught.exception.category, "auth_failure")

    def test_dns_errors_wrapped_by_the_library_are_recognised_through_the_cause_chain(self):
        try:
            try:
                raise socket.gaierror(8, "nodename")
            except socket.gaierror as inner:
                raise RuntimeError("Bad IPv4/UDP transport address") from inner
        except RuntimeError as wrapped:
            self.assertEqual(classify_exception(wrapped)[0], "dns_failure")

    def test_other_error_kinds(self):
        self.assertEqual(classify_exception(TimeoutError())[0], "timeout")
        self.assertEqual(classify_exception(OSError(101, "Network is unreachable"))[0], "unreachable")
        self.assertEqual(classify_exception(ValueError("odd"))[0], "unknown")

        class WrongDigest(Exception):
            pass

        class ParseError(Exception):
            pass

        self.assertEqual(classify_exception(WrongDigest("Wrong SNMP PDU digest"))[0], "auth_failure")
        self.assertEqual(classify_exception(ParseError("bad"))[0], "protocol_error")


if __name__ == "__main__":
    unittest.main()
