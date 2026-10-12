"""SNMP collector against a real SNMP agent simulator (snmpsim).

These tests use the real pysnmp transport, real SNMPv2c and SNMPv3
(authentication and privacy) over UDP on localhost, and simulated devices
(``snmpsim_fixture``). They are skipped when pysnmp, snmpsim, pysmi or
cryptography are not installed (``pip install "./agent[snmp]" snmpsim pysmi``);
the rest of the suite needs none of them.
"""

import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from agent.config import Config
from agent.errors import HeartbeatError
from agent.heartbeat import send_heartbeat
from agent.http_client import HttpResponse
from agent.snmp_collector import DevicePoller
from agent.snmp_config import SnmpCredential, SnmpDeviceConfig, InterfaceSelection
from agent.snmp_fetch import (
    FetchPlan,
    PysnmpFetcher,
    SnmpFetchCancelled,
    SnmpFetchError,
)
from agent.snmp_payload import sanitize_poll
from agent.snmp_runtime import SnmpRuntime
from agent.tests import snmpsim_fixture
from agent.tests.snmpsim_fixture import BIG_INTERFACES, Simulator

SKIP_REASON = snmpsim_fixture.available()

AUTH = {"SHA": "SHA", "SHA224": "SHA-224", "SHA256": "SHA-256", "SHA384": "SHA-384", "SHA512": "SHA-512"}
PRIV = {"AES": "AES-128", "AES192": "AES-192", "AES256": "AES-256", "NONE": ""}

IF1_IN = "1.3.6.1.2.1.31.1.1.1.6.1"
IF1_OUT = "1.3.6.1.2.1.31.1.1.1.10.1"
IF1_ERRORS = "1.3.6.1.2.1.2.2.1.14.1"
SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
IF_TABLE_LAST_CHANGE = "1.3.6.1.2.1.31.1.5.0"
LEGACY_IN32 = "1.3.6.1.2.1.2.2.1.10.1"


def v2c(community="public"):
    return SnmpCredential(name="p", version="2c", community=community)


def v3(engine, **overrides):
    values = {
        "name": "p",
        "version": "3",
        "username": engine.user,
        "auth_protocol": AUTH[engine.auth_protocol],
        "auth_password": engine.auth_key,
        "priv_protocol": PRIV[engine.priv_protocol],
        "priv_password": engine.priv_key,
        "context_name": "public",  # snmpsim selects the simulated device by context
    }
    values.update(overrides)
    return SnmpCredential(**values)


def device(port, **overrides):
    values = {
        "id": uuid.uuid4(),
        "name": "sim",
        "address": "127.0.0.1",
        "credential_profile": "p",
        "port": port,
        "timeout_seconds": 2,
        "retries": 0,
    }
    values.update(overrides)
    return SnmpDeviceConfig(**values)


def interfaces(poll):
    return {entry["if_index"]: entry for entry in poll["interfaces"]}


def make_poller(port, credential, **overrides):
    return DevicePoller(device(port, **overrides), credential, PysnmpFetcher())


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class SimulatorTestCase(unittest.TestCase):
    """One simulator for the class; tests must not change what it serves."""

    @classmethod
    def setUpClass(cls):
        cls.sim = Simulator()
        cls.sim.start()

    @classmethod
    def tearDownClass(cls):
        cls.sim.stop()


class ProtocolTests(SimulatorTestCase):
    def test_v2c_discovery_poll_reads_the_whole_device(self):
        poll = make_poller(self.sim.v2c_port, v2c()).poll()
        self.assertTrue(poll["reachable"])
        self.assertGreater(poll["response_ms"], 0)
        self.assertEqual(poll["sys_uptime_ticks"], 8_123_456)
        self.assertEqual(
            poll["system"],
            {"name": "test-sw-1", "descr": "Test Switch OS 1.0", "object_id": "1.3.6.1.4.1.8072.3.2.10"},
        )
        self.assertTrue(poll["interfaces_complete"])
        found = interfaces(poll)
        self.assertEqual(sorted(found), [1, 2, 3])
        one = found[1]
        self.assertEqual(
            {k: v for k, v in one.items() if k != "counters"},
            {
                "if_index": 1,
                "name": "Gi0/1",
                "descr": "GigabitEthernet0/1",
                "alias": "uplink to dc2",
                "if_type": 6,
                "speed_bps": 1_000_000_000,
                "admin_status": 1,
                "oper_status": 1,
            },
        )
        self.assertEqual(one["counters"]["octets_bits"], 64)
        self.assertEqual(one["counters"]["delta_state"], "first")
        self.assertEqual(one["counters"]["raw"]["in_octets"], 123_456_789_012)
        self.assertEqual(one["counters"]["raw"]["out_octets"], 98_765_432_109)
        two = found[2]
        self.assertEqual((two["oper_status"], two["speed_bps"]), (2, 10_000_000_000))  # ifHighSpeed beats saturated ifSpeed
        self.assertEqual((two["counters"]["raw"]["in_errors"], two["counters"]["raw"]["in_discards"]), (2, 1))

    def test_the_loopback_is_listed_but_not_monitored(self):
        found = interfaces(make_poller(self.sim.v2c_port, v2c()).poll())
        self.assertNotIn("counters", found[3])
        self.assertEqual(found[3]["if_type"], 24)

    def test_include_patterns_can_monitor_it(self):
        poller = make_poller(
            self.sim.v2c_port, v2c(), interfaces=InterfaceSelection(include=["Loopback*"])
        )
        found = interfaces(poller.poll())
        self.assertEqual({i for i, e in found.items() if "counters" in e}, {3})

    def test_every_v3_authentication_and_privacy_combination(self):
        for label, engine in self.sim.engines.items():
            with self.subTest(label):
                poll = make_poller(engine.port, v3(engine)).poll()
                self.assertTrue(poll["reachable"], poll)
                self.assertEqual(poll["system"]["name"], "test-sw-1")
                self.assertEqual(sorted(interfaces(poll)), [1, 2, 3])
                self.assertEqual(interfaces(poll)[1]["counters"]["raw"]["in_octets"], 123_456_789_012)

    def test_a_device_with_only_32_bit_counters_falls_back(self):
        poll = make_poller(self.sim.v2c_port, v2c("legacy")).poll()
        found = interfaces(poll)
        self.assertEqual(sorted(found), [1, 2])
        self.assertEqual(found[1]["name"], "eth0")  # no ifXTable: ifDescr is the name
        counters = found[1]["counters"]
        self.assertEqual(counters["octets_bits"], 32)
        self.assertEqual((counters["raw"]["in_octets"], counters["raw"]["out_octets"]), (4_294_967_000, 10))
        self.assertEqual(found[1]["speed_bps"], 1_000_000_000)
        self.assertIsNone(found[2]["speed_bps"])  # ifSpeed saturated, no ifHighSpeed

    def test_a_device_without_if_mib_is_reachable_with_no_interfaces(self):
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            poll = make_poller(self.sim.v2c_port, v2c("bare")).poll()
        self.assertTrue(poll["reachable"])
        self.assertEqual(poll["interfaces"], [])
        self.assertFalse(poll["interfaces_complete"])
        self.assertEqual(poll["system"]["name"], "appliance")
        self.assertIn("no interfaces", "\n".join(logs.output))

    def test_a_large_table_is_walked_completely_over_many_bulk_responses(self):
        poll = make_poller(self.sim.v2c_port, v2c("big")).poll()
        found = interfaces(poll)
        self.assertEqual(len(found), BIG_INTERFACES)
        self.assertTrue(poll["interfaces_complete"])
        self.assertEqual(found[130]["name"], "Eth1/130")
        self.assertEqual(found[130]["counters"]["raw"]["in_octets"], 130_000)
        self.assertEqual(found[7]["alias"], "port 7")
        sanitize_poll(poll)

    def test_the_monitored_cap_applies_to_a_large_table(self):
        poller = make_poller(self.sim.v2c_port, v2c("big"), interfaces=InterfaceSelection(max_interfaces=10))
        with self.assertLogs("sentinel_agent", level="WARNING"):
            poll = poller.poll()
        monitored = [i for i, e in interfaces(poll).items() if "counters" in e]
        self.assertEqual(sorted(monitored), list(range(1, 11)))
        self.assertEqual(len(poll["interfaces"]), BIG_INTERFACES)

    def test_every_payload_passes_the_queue_whitelist_unchanged(self):
        for credential in (v2c(), v2c("legacy"), v2c("big")):
            poll = make_poller(self.sim.v2c_port, credential).poll()
            _id, text, _count = sanitize_poll(poll)
            self.assertEqual(json.loads(text), json.loads(json.dumps(poll)))


class FailureTests(SimulatorTestCase):
    def fetch_error(self, port, credential, **overrides):
        overrides.setdefault("timeout_seconds", 1)
        with self.assertRaises(SnmpFetchError) as caught:
            PysnmpFetcher().fetch(device(port, **overrides), credential, FetchPlan())
        return caught.exception

    def poll(self, port, credential, **overrides):
        overrides.setdefault("timeout_seconds", 1)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            return make_poller(port, credential, **overrides).poll()

    def test_nothing_listening_is_a_timeout(self):
        started = time.monotonic()
        poll = self.poll(_unused_port(), v2c())
        self.assertEqual((poll["reachable"], poll["error"]), (False, "timeout"))
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(set(poll), {"poll_id", "device_id", "measured_at", "reachable", "error"})

    def test_a_wrong_community_is_a_timeout_because_devices_stay_silent(self):
        self.assertEqual(self.poll(self.sim.v2c_port, v2c("no-such-community"))["error"], "timeout")

    def test_retries_extend_the_wait(self):
        started = time.monotonic()
        error = self.fetch_error(_unused_port(), v2c(), timeout_seconds=1, retries=1)
        self.assertEqual(error.category, "timeout")
        self.assertGreaterEqual(time.monotonic() - started, 1.8)

    def test_wrong_v3_credentials_are_authentication_failures(self):
        engine = self.sim.engines["sha256-aes128"]
        cases = {
            "wrong authentication password": v3(engine, auth_password="not-the-auth-password"),
            "unknown user": v3(engine, username="nobody"),
            "wrong privacy password": v3(engine, priv_password="not-the-priv-password"),
            "privacy missing on the manager": v3(engine, priv_protocol="", priv_password=""),
            "wrong authentication protocol": v3(engine, auth_protocol="SHA-512"),
        }
        for label, credential in cases.items():
            with self.subTest(label):
                self.assertEqual(self.fetch_error(engine.port, credential).category, "auth_failure")

    def test_privacy_requested_from_a_device_without_privacy_gets_no_answer(self):
        engine = self.sim.engines["sha224-nopriv"]
        error = self.fetch_error(engine.port, v3(engine, priv_protocol="AES-128", priv_password="privpass-extra"))
        self.assertEqual(error.category, "timeout")

    def test_an_unresolvable_name_is_a_dns_failure(self):
        error = self.fetch_error(self.sim.v2c_port, v2c(), address="no-such-host.invalid")
        self.assertEqual(error.category, "dns_failure")
        self.assertNotIn("no-such-host", str(error))

    def test_a_device_without_sysuptime_is_unsupported(self):
        # Nothing in the simulator answers 'sysUpTime' for an unknown context
        # name over SNMPv3: it is reported as no answer, not as a poll with data.
        engine = self.sim.engines["sha256-aes128"]
        error = self.fetch_error(engine.port, v3(engine, context_name="missing-context"))
        self.assertIn(error.category, {"timeout", "unsupported", "auth_failure"})

    def test_error_messages_never_contain_secrets(self):
        engine = self.sim.engines["sha256-aes128"]
        credential = v3(engine, auth_password="wrong-auth-SECRET-123", priv_password="wrong-priv-SECRET-456")
        error = self.fetch_error(engine.port, credential)
        text = repr(error) + str(error)
        for secret in credential.secrets():
            self.assertNotIn(secret, text)
        poll = self.poll(engine.port, credential)
        self.assertNotIn("SECRET", json.dumps(poll))

    def test_the_poll_has_a_hard_deadline(self):
        started = time.monotonic()
        with self.assertRaises(SnmpFetchError) as caught:
            PysnmpFetcher(max_poll_seconds=0.8).fetch(
                device(_unused_port(), timeout_seconds=10, retries=3, poll_interval_seconds=300),
                v2c(),
                FetchPlan(),
            )
        self.assertEqual(caught.exception.category, "timeout")
        self.assertIn("deadline", str(caught.exception))
        self.assertLess(time.monotonic() - started, 4)

    def test_a_hanging_name_resolution_cannot_outlive_the_deadline_or_a_cancellation(self):
        release = threading.Event()
        self.addCleanup(release.set)
        with patch("socket.getaddrinfo", side_effect=lambda *a, **k: release.wait(30)):
            started = time.monotonic()
            with self.assertRaises(SnmpFetchError) as caught:
                PysnmpFetcher(max_poll_seconds=1.0).fetch(
                    device(self.sim.v2c_port, address="slow.example", poll_interval_seconds=300), v2c(), FetchPlan()
                )
            self.assertEqual(caught.exception.category, "dns_failure")
            self.assertLess(time.monotonic() - started, 3)

            cancel = threading.Event()
            threading.Timer(0.3, cancel.set).start()
            started = time.monotonic()
            with self.assertRaises(SnmpFetchCancelled):
                PysnmpFetcher().fetch(device(self.sim.v2c_port, address="slow.example"), v2c(), FetchPlan(), cancel)
            self.assertLess(time.monotonic() - started, 3)

    def test_a_poll_can_be_cancelled_from_another_thread(self):
        cancel = threading.Event()
        threading.Timer(0.3, cancel.set).start()
        started = time.monotonic()
        with self.assertRaises(SnmpFetchCancelled):
            PysnmpFetcher().fetch(device(_unused_port(), timeout_seconds=30, retries=3), v2c(), FetchPlan(), cancel)
        self.assertLess(time.monotonic() - started, 3)


def _unused_port():
    return snmpsim_fixture._free_ports(1)[0]


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class DeltaTests(unittest.TestCase):
    """Exact deltas: counters are moved with SNMP SETs between two polls."""

    def setUp(self):
        self.sim = Simulator()
        self.sim.start()
        self.addCleanup(self.sim.stop)

    def counters(self, poller):
        return interfaces(poller.poll())[1]["counters"]

    def test_first_ok_reset_and_reboot(self):
        poller = make_poller(self.sim.v2c_port, v2c())
        self.assertEqual(self.counters(poller)["delta_state"], "first")

        self.sim.set_values(
            "public",
            {IF1_IN: ("counter64", 123_456_789_012 + 3_000_000), IF1_OUT: ("counter64", 98_765_432_109 + 500), IF1_ERRORS: ("counter32", 4), SYS_UPTIME: ("timeticks", 8_200_000)},
        )
        second = self.counters(poller)
        self.assertEqual(second["delta_state"], "ok")
        self.assertEqual(second["delta"]["in_octets"], 3_000_000)
        self.assertEqual(second["delta"]["out_octets"], 500)
        self.assertEqual(second["delta"]["in_errors"], 4)
        self.assertGreater(second["interval_seconds"], 0)
        self.assertEqual(second["raw"]["in_octets"], 123_456_789_012 + 3_000_000)

        self.sim.set_values("public", {IF1_IN: ("counter64", 10), SYS_UPTIME: ("timeticks", 8_300_000)})
        third = self.counters(poller)
        self.assertEqual(third["delta_state"], "reset")
        self.assertNotIn("delta", third)

        self.sim.set_values("public", {IF1_IN: ("counter64", 50), IF1_OUT: ("counter64", 5), SYS_UPTIME: ("timeticks", 100)})
        fourth = self.counters(poller)
        self.assertEqual(fourth["delta_state"], "reboot")

        self.sim.set_values("public", {IF1_IN: ("counter64", 150), IF1_OUT: ("counter64", 25), SYS_UPTIME: ("timeticks", 5_000)})
        fifth = self.counters(poller)
        self.assertEqual((fifth["delta_state"], fifth["delta"]["in_octets"]), ("ok", 100))

    def test_a_32_bit_counter_wrap_is_accounted_for(self):
        poller = make_poller(self.sim.v2c_port, v2c("legacy"))
        first = self.counters(poller)
        self.assertEqual(first["raw"]["in_octets"], 4_294_967_000)
        self.sim.set_values("legacy", {LEGACY_IN32: ("counter32", 1_000)})  # wrapped: 296 to the top + 1000
        second = self.counters(poller)
        self.assertEqual(second["delta_state"], "ok")
        self.assertEqual(second["delta"]["in_octets"], 4_294_967_296 - 4_294_967_000 + 1_000)

    def test_a_table_change_marker_triggers_rediscovery(self):
        poller = make_poller(self.sim.v2c_port, v2c())
        first = poller.poll()
        self.assertIn("system", first)
        self.assertNotIn("system", poller.poll())  # regular poll
        self.sim.set_values("public", {IF_TABLE_LAST_CHANGE: ("timeticks", 200)})
        self.assertNotIn("system", poller.poll())  # notices the change...
        again = poller.poll()  # ...and rediscovers on the next poll
        self.assertIn("system", again)
        self.assertTrue(again["interfaces_complete"])
        self.assertNotIn("system", poller.poll())  # and settles


@unittest.skipIf(SKIP_REASON, SKIP_REASON or "")
class PipelineTests(unittest.TestCase):
    """Config files -> scheduler -> queue -> heartbeat -> acknowledgement."""

    @classmethod
    def setUpClass(cls):
        cls.sim = Simulator()
        cls.sim.start()

    @classmethod
    def tearDownClass(cls):
        cls.sim.stop()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        os.chmod(self.dir, 0o700)
        self.addCleanup(self._tmp.cleanup)
        engine = self.sim.engines["sha256-aes128"]
        # "public" is the community of the v2c device: it must not appear anywhere either.
        self.secrets = [engine.auth_key, engine.priv_key, "public"]
        self.sent = []
        profiles = {
            "v3": {
                "version": "3",
                "username": engine.user,
                "auth_protocol": "SHA-256",
                "auth_password": engine.auth_key,
                "priv_protocol": "AES-128",
                "priv_password": engine.priv_key,
                "context_name": "public",
            },
            "v2": {"version": "2c", "community": "public"},
        }
        credentials = self.dir / "credentials.json"
        credentials.write_text(json.dumps({"profiles": profiles}))
        os.chmod(credentials, 0o600)
        self.device_ids = [str(uuid.uuid4()) for _ in range(3)]
        devices = [
            {"id": self.device_ids[0], "name": "v3-switch", "address": "127.0.0.1", "port": engine.port, "credential_profile": "v3", "timeout_seconds": 1, "retries": 0},
            {"id": self.device_ids[1], "name": "v2c-switch", "address": "127.0.0.1", "port": self.sim.v2c_port, "credential_profile": "v2", "timeout_seconds": 1, "retries": 0},
            {"id": self.device_ids[2], "name": "dead", "address": "127.0.0.1", "port": _unused_port(), "credential_profile": "v2", "timeout_seconds": 1, "retries": 0},
        ]
        devices_file = self.dir / "devices.json"
        devices_file.write_text(json.dumps({"devices": devices}))
        self.queue_path = self.dir / "state" / "queue.sqlite3"
        self.env = {
            "SENTINEL_SNMP_DEVICES_FILE": str(devices_file),
            "SENTINEL_SNMP_CREDENTIALS_FILE": str(credentials),
            "SENTINEL_QUEUE_PATH": str(self.queue_path),
            "SENTINEL_SNMP_MAX_CONCURRENT_POLLS": "2",
        }

    def beat(self, runtime, *, respond):
        def post(url, *, headers=None, payload=None, timeout=10.0):
            self.sent.append(payload)
            return respond(payload)

        with patch("agent.heartbeat.post_json", side_effect=post):
            send_heartbeat(
                Config(sentinel_url="https://sentinel.example", agent_token="agent-token"),
                collect_fn=lambda: {"version": 1},
                docker_fn=lambda: {"version": 1},
                snmp_delivery=runtime.delivery,
            )
        return self.sent[-1]

    @staticmethod
    def ack_all(payload):
        return HttpResponse(
            200,
            json.dumps(
                {
                    "status": "ok",
                    "snmp": "accepted",
                    "snmp_results": [{"poll_id": p["poll_id"], "result": "created"} for p in payload["snmp"]["polls"]],
                }
            ),
        )

    def test_poll_queue_deliver_acknowledge(self):
        with self.assertLogs("sentinel_agent", level="WARNING"):
            runtime = SnmpRuntime.from_environment(self.env)
            self.addCleanup(runtime.stop)
            self.assertEqual(runtime.poll_once(), 3)
        self.assertEqual(runtime.queue.snmp_count(), 3)

        payload = self.beat(runtime, respond=self.ack_all)
        polls = {p["device_id"]: p for p in payload["snmp"]["polls"]}
        self.assertEqual(set(polls), set(self.device_ids))
        self.assertTrue(polls[self.device_ids[0]]["reachable"])
        self.assertTrue(polls[self.device_ids[1]]["reachable"])
        dead = polls[self.device_ids[2]]
        self.assertEqual((dead["reachable"], dead["error"]), (False, "timeout"))
        self.assertEqual(sorted(interfaces(polls[self.device_ids[0]])), [1, 2, 3])
        self.assertLess(len(json.dumps(payload)), 100_000)
        self.assertEqual(runtime.queue.snmp_count(), 0)

    def test_nothing_secret_is_queued_sent_or_logged(self):
        with self.assertLogs("sentinel_agent", level="DEBUG") as logs:
            runtime = SnmpRuntime.from_environment(self.env)
            self.addCleanup(runtime.stop)
            runtime.poll_once()
            with self.assertRaises(HeartbeatError):
                self.beat(runtime, respond=lambda payload: HttpResponse(500, "boom"))
        self.assertEqual(runtime.queue.snmp_count(), 3)  # kept for the next attempt
        runtime.queue.close()
        stored = b"".join(p.read_bytes() for p in self.queue_path.parent.iterdir())
        sent = json.dumps(self.sent)
        logged = "\n".join(logs.output)
        for secret in self.secrets:
            self.assertNotIn(secret.encode(), stored)
            self.assertNotIn(secret, sent)
            self.assertNotIn(secret, logged)

    def test_the_scheduler_polls_in_the_background_with_bounded_threads(self):
        with self.assertLogs("sentinel_agent", level="WARNING"):
            runtime = SnmpRuntime.from_environment(self.env)
            self.addCleanup(runtime.stop)
            runtime.start()
            seen = []
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and runtime.queue.snmp_count() < 3:
                seen.append(len([t for t in threading.enumerate() if t.name.startswith("sentinel-snmp_")]))
                time.sleep(0.02)
            queued = runtime.queue.snmp_count()
            runtime.stop()
        self.assertEqual(queued, 3)
        self.assertLessEqual(max(seen), 2)  # SENTINEL_SNMP_MAX_CONCURRENT_POLLS=2
        self.assertEqual([t.name for t in threading.enumerate() if t.name.startswith("sentinel-snmp")], [])


if __name__ == "__main__":
    unittest.main()
