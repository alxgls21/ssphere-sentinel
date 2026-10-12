"""The real agent process, a simulated SNMP device and the real server, end to end.

``sentinel-agent heartbeat`` runs as a subprocess with the SNMP extra, polls
snmpsim over SNMPv3 (SHA-256 and AES-128) and a device that does not answer,
and delivers to a live Sentinel server over HTTP; the stored rows are then
inspected. Skipped unless pysnmp, snmpsim, pysmi, cryptography and psutil are
installed (``pip install "./agent[snmp]" snmpsim pysmi``), so it never runs in
an environment that only has the server.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from django.test import LiveServerTestCase

from agent.measurement_queue import MeasurementQueue
from agent.tests import snmpsim_fixture
from apps.inventory.models import Device
from apps.snmp.models import DevicePoll, DeviceSnmpState, Interface, InterfaceSample, SnmpConfig
from apps.snmp.tests.helpers import make_agent

REPO_ROOT = Path(__file__).resolve().parents[3]


def skip_reason():
    reason = snmpsim_fixture.available()
    if reason:
        return reason
    if importlib.util.find_spec("psutil") is None:
        return "the agent needs psutil"
    return None


@unittest.skipIf(skip_reason(), skip_reason() or "")
class AgentEndToEndTests(LiveServerTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.sim = snmpsim_fixture.Simulator()
        cls.sim.start()

    @classmethod
    def tearDownClass(cls):
        cls.sim.stop()
        super().tearDownClass()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        os.chmod(self.dir, 0o700)

        self.agent, self.token = make_agent("e2e-agent")
        self.good = Device.objects.create(name="sim-switch", management_address="127.0.0.1", assigned_agent=self.agent)
        self.dead = Device.objects.create(name="dead-switch", management_address="127.0.0.1", assigned_agent=self.agent)
        for device in (self.good, self.dead):
            SnmpConfig.objects.create(device=device, credential_profile="lab-v3")

        engine = self.sim.engines["sha256-aes128"]
        self.secrets = [engine.auth_key, engine.priv_key]
        credentials = self.dir / "credentials.json"
        credentials.write_text(
            json.dumps(
                {
                    "profiles": {
                        "lab-v3": {
                            "version": "3",
                            "username": engine.user,
                            "auth_protocol": "SHA-256",
                            "auth_password": engine.auth_key,
                            "priv_protocol": "AES-128",
                            "priv_password": engine.priv_key,
                            "context_name": "public",  # snmpsim picks the simulated device by context
                        }
                    }
                }
            )
        )
        os.chmod(credentials, 0o600)
        dead_port = snmpsim_fixture._free_ports(1)[0]
        devices = self.dir / "devices.json"
        devices.write_text(
            json.dumps(
                {
                    "devices": [
                        {"id": str(self.good.pk), "name": "sim-switch", "address": "127.0.0.1", "port": engine.port, "credential_profile": "lab-v3", "timeout_seconds": 2, "retries": 0},
                        {"id": str(self.dead.pk), "name": "dead-switch", "address": "127.0.0.1", "port": dead_port, "credential_profile": "lab-v3", "timeout_seconds": 1, "retries": 0},
                    ]
                }
            )
        )
        self.queue_path = self.dir / "state" / "queue.sqlite3"
        self.env = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(REPO_ROOT),
            "SENTINEL_URL": self.live_server_url,
            "SENTINEL_AGENT_TOKEN": self.token,
            "SENTINEL_SNMP_DEVICES_FILE": str(devices),
            "SENTINEL_SNMP_CREDENTIALS_FILE": str(credentials),
            "SENTINEL_QUEUE_PATH": str(self.queue_path),
            "XDG_STATE_HOME": str(self.dir / "xdg"),
        }

    def run_agent(self):
        return subprocess.run(  # noqa: S603 - fixed test command
            [sys.executable, "-W", "ignore::DeprecationWarning", "-m", "agent", "heartbeat"],
            cwd=REPO_ROOT,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def test_a_one_shot_heartbeat_polls_over_snmpv3_and_the_server_stores_it(self):
        result = self.run_agent()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Heartbeat successful.")

        polls = {poll.device_id: poll for poll in DevicePoll.objects.all()}
        self.assertEqual(set(polls), {self.good.pk, self.dead.pk})
        good, dead = polls[self.good.pk], polls[self.dead.pk]
        self.assertTrue(good.reachable)
        self.assertEqual(good.sys_uptime_ticks, 8_123_456)
        self.assertFalse(dead.reachable)
        self.assertEqual(dead.error, "timeout")

        state = DeviceSnmpState.objects.get(pk=self.good.pk)
        self.assertEqual((state.sys_name, state.sys_descr), ("test-sw-1", "Test Switch OS 1.0"))
        self.assertIsNotNone(state.last_discovery_at)
        self.assertFalse(DeviceSnmpState.objects.get(pk=self.dead.pk).reachable)

        interfaces = {i.if_index: i for i in Interface.objects.filter(device=self.good)}
        self.assertEqual(sorted(interfaces), [1, 2, 3])
        self.assertEqual((interfaces[1].name, interfaces[1].alias), ("Gi0/1", "uplink to dc2"))
        self.assertEqual(interfaces[2].speed_bps, 10_000_000_000)
        samples = InterfaceSample.objects.filter(interface__device=self.good)
        self.assertEqual(sorted(samples.values_list("interface__if_index", flat=True)), [1, 2])  # loopback not monitored
        first = samples.get(interface__if_index=1)
        self.assertEqual((first.delta_state, first.octets_bits), ("first", 64))
        self.assertEqual((first.in_octets, first.out_octets), (123_456_789_012, 98_765_432_109))

    def test_the_agent_queue_is_empty_after_acknowledgement_and_nothing_secret_is_stored(self):
        result = self.run_agent()
        self.assertEqual(result.returncode, 0, result.stderr)
        queue = MeasurementQueue.open(self.queue_path)
        try:
            self.assertEqual(queue.snmp_count(), 0)
        finally:
            queue.close()

        everything = [result.stdout, result.stderr]
        for model in (DevicePoll, DeviceSnmpState, Interface, InterfaceSample, SnmpConfig, Device):
            everything += [repr(row) for row in model.objects.values()]
        files = b"".join(path.read_bytes() for path in self.queue_path.parent.iterdir())
        for secret in self.secrets:
            self.assertNotIn(secret.encode(), files)
            self.assertFalse(any(secret in text for text in everything), secret)

    def test_a_second_run_resends_nothing_and_stores_a_new_poll(self):
        self.assertEqual(self.run_agent().returncode, 0)
        self.assertEqual(self.run_agent().returncode, 0)
        self.assertEqual(DevicePoll.objects.filter(device=self.good).count(), 2)
        # A new process has no previous counters: its first sample is "first" again.
        self.assertEqual(
            sorted(InterfaceSample.objects.filter(interface__if_index=1).values_list("delta_state", flat=True)),
            ["first", "first"],
        )

    def test_a_server_that_does_not_know_the_device_keeps_the_poll_for_later(self):
        stranger = str(uuid.uuid4())
        devices = json.loads((self.dir / "devices.json").read_text())
        devices["devices"][0]["id"] = stranger
        (self.dir / "devices.json").write_text(json.dumps(devices))
        result = self.run_agent()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("will retry", result.stderr)
        queue = MeasurementQueue.open(self.queue_path)
        try:
            self.assertEqual(queue.snmp_count(), 1)  # the unknown device's poll; the dead one was accepted
        finally:
            queue.close()
        self.assertFalse(DevicePoll.objects.filter(device=self.good).exists())
