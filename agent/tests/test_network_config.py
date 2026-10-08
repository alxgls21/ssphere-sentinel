import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from agent.errors import ConfigError
from agent.network_config import load_network_targets, validate_hostname_or_ip


class NetworkConfigTests(unittest.TestCase):
    def test_valid_config_loads(self):
        target_id = str(uuid4())
        payload = {
            "targets": [
                {
                    "id": target_id,
                    "name": "dns",
                    "hostname_or_ip": "1.1.1.1",
                    "protocol": "tcp",
                    "port": 443,
                    "enabled": True,
                    "monitoring_interval_seconds": 60,
                    "timeout_seconds": 2,
                    "probe_count": 4,
                }
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "targets.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            targets = load_network_targets(
                {"SENTINEL_NETWORK_TARGETS_FILE": str(path)}
            )
        self.assertEqual(len(targets), 1)
        self.assertEqual(str(targets[0].id), target_id)
        self.assertEqual(targets[0].port, 443)

    def test_invalid_host_rejected(self):
        with self.assertRaises(ConfigError):
            validate_hostname_or_ip("bad;host")
        with self.assertRaises(ConfigError):
            validate_hostname_or_ip("has space.com")

    def test_invalid_target_configuration(self):
        payload = {
            "targets": [
                {
                    "id": str(uuid4()),
                    "name": "bad",
                    "hostname_or_ip": "example.com",
                    "protocol": "tcp",
                    "port": None,
                    "enabled": True,
                }
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "targets.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_network_targets(
                    {"SENTINEL_NETWORK_TARGETS_FILE": str(path)}
                )

    def test_missing_file_env_returns_empty(self):
        self.assertEqual(load_network_targets({}), [])
