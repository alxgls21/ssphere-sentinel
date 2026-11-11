"""Validation gaps in ``agent.config`` and ``agent.network_config``.

``ConfigTests`` in test_config.py cover the happy path, credentials in the URL,
and a few bad intervals. Not covered:

* ``UrlTests`` / ``NetworkTargetsFileTests`` pin behaviour that already held.
* ``SuspectedBugTests`` assert what the configuration should do. They were written
  against these defects, before the fixes; they pass against the current code and
  guard it:
    - a URL with a query string or fragment built a broken ``heartbeat_url``;
    - a URL with a non-numeric or out-of-range port was accepted, and failed later
      inside ``urllib`` with ``http.client.InvalidURL`` (not an ``OSError``);
    - a heartbeat interval above ``threading.TIMEOUT_MAX`` was accepted, and then
      ``Event.wait`` raised ``OverflowError`` in ``run_continuous`` after the first
      heartbeat, which stopped the agent;
    - a targets file that is not UTF-8 or cannot be read raised
      ``UnicodeDecodeError`` / ``OSError`` instead of ``ConfigError``.
"""

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from uuid import uuid4

from agent.config import load_config, uses_insecure_http
from agent.errors import ConfigError
from agent.network_config import (
    ENV_NETWORK_TARGETS_FILE,
    MAX_TARGETS,
    load_network_targets,
    validate_hostname_or_ip,
)


def _env(url="https://sentinel.example.com", token="secret-token", **extra):
    env = {"SENTINEL_URL": url, "SENTINEL_AGENT_TOKEN": token}
    env.update(extra)
    return env


class UrlTests(unittest.TestCase):
    def test_only_absolute_http_and_https_urls_are_accepted(self):
        for url in (
            "ftp://sentinel.example.com",
            "file:///etc/passwd",
            "localhost:8080",  # urlparse reads "localhost" as the scheme
            "//sentinel.example.com",
            "sentinel.example.com",
            "https://",
            "http:///path",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ConfigError) as ctx:
                    load_config(_env(url=url))
                self.assertIn("SENTINEL_URL", str(ctx.exception))

    def test_a_path_prefix_is_kept_and_trailing_slashes_are_removed(self):
        config = load_config(_env(url="https://host.example/sentinel///"))
        self.assertEqual(config.sentinel_url, "https://host.example/sentinel")
        self.assertEqual(
            config.heartbeat_url, "https://host.example/sentinel/api/v1/agent/heartbeat/"
        )

    def test_scheme_case_is_not_significant(self):
        self.assertFalse(uses_insecure_http(load_config(_env(url="HTTPS://host.example"))))
        self.assertTrue(uses_insecure_http(load_config(_env(url="HTTP://host.example"))))

    def test_surrounding_whitespace_is_removed_from_url_token_and_interval(self):
        config = load_config(
            _env(url="  https://host.example  ", token=" tok \n", SENTINEL_HEARTBEAT_INTERVAL=" 45 ")
        )
        self.assertEqual(config.sentinel_url, "https://host.example")
        self.assertEqual(config.agent_token, "tok")
        self.assertEqual(config.heartbeat_interval, 45)

    def test_an_empty_interval_means_the_default(self):
        self.assertEqual(load_config(_env(SENTINEL_HEARTBEAT_INTERVAL="  ")).heartbeat_interval, 30)

    def test_error_messages_never_contain_the_token(self):
        for url in ("ftp://x", "https://user:pw@x"):
            with self.subTest(url=url):
                with self.assertRaises(ConfigError) as ctx:
                    load_config(_env(url=url, token="very-secret-token"))
                self.assertNotIn("very-secret-token", str(ctx.exception))


class SuspectedBugTests(unittest.TestCase):
    def test_a_query_string_is_refused(self):
        with self.assertRaises(ConfigError):
            load_config(_env(url="https://host.example/?tenant=1"))

    def test_a_fragment_is_refused(self):
        with self.assertRaises(ConfigError):
            load_config(_env(url="https://host.example/#top"))

    def test_a_port_that_is_not_a_port_is_refused(self):
        for url in ("https://host.example:abc", "https://host.example:99999"):
            with self.subTest(url=url):
                with self.assertRaises(ConfigError):
                    load_config(_env(url=url))

    def test_event_wait_really_overflows_above_timeout_max(self):
        # Evidence for the bug above: the runner's wait cannot take this value.
        with self.assertRaises(OverflowError):
            threading.Event().wait(timeout=threading.TIMEOUT_MAX + 1)

    def test_an_interval_that_event_wait_cannot_take_is_refused(self):
        too_big = str(int(threading.TIMEOUT_MAX) + 1)
        with self.assertRaises(ConfigError):
            load_config(_env(SENTINEL_HEARTBEAT_INTERVAL=too_big))


class NetworkTargetsFileTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "targets.json"
        self.env = {ENV_NETWORK_TARGETS_FILE: str(self.path)}

    def write(self, targets):
        self.path.write_text(json.dumps({"targets": targets}), encoding="utf-8")

    @staticmethod
    def target(**overrides):
        data = {
            "id": str(uuid4()),
            "name": "gateway",
            "hostname_or_ip": "192.0.2.1",
            "protocol": "icmp",
        }
        data.update(overrides)
        return data

    def test_more_than_the_maximum_number_of_targets_is_refused(self):
        self.write([self.target() for _ in range(MAX_TARGETS + 1)])
        with self.assertRaises(ConfigError):
            load_network_targets(self.env)

    def test_exactly_the_maximum_is_accepted(self):
        self.write([self.target() for _ in range(MAX_TARGETS)])
        self.assertEqual(len(load_network_targets(self.env)), MAX_TARGETS)

    def test_duplicate_ids_are_refused(self):
        same = str(uuid4())
        self.write([self.target(id=same), self.target(id=same, name="other")])
        with self.assertRaisesRegex(ConfigError, "duplicate"):
            load_network_targets(self.env)

    def test_field_rules(self):
        cases = {
            "icmp with a port": self.target(port=80),
            "tcp without a port": self.target(protocol="tcp"),
            "tcp with a boolean port": self.target(protocol="tcp", port=True),
            "port zero": self.target(protocol="tcp", port=0),
            "port too high": self.target(protocol="tcp", port=65536),
            "interval too short": self.target(monitoring_interval_seconds=9),
            "interval too long": self.target(monitoring_interval_seconds=86401),
            "timeout zero": self.target(timeout_seconds=0),
            "probe count zero": self.target(probe_count=0),
            "probe count too high": self.target(probe_count=21),
            "float interval": self.target(monitoring_interval_seconds=60.0),
            "string enabled": self.target(enabled="yes"),
            "unknown protocol": self.target(protocol="udp"),
            "empty name": self.target(name="  "),
            "name too long": self.target(name="n" * 256),
            "bad id": self.target(id="not-a-uuid"),
        }
        for label, item in cases.items():
            with self.subTest(label):
                self.write([item])
                with self.assertRaises(ConfigError):
                    load_network_targets(self.env)

    def test_defaults_apply_when_fields_are_missing_or_null(self):
        self.write([self.target(monitoring_interval_seconds=None)])
        (loaded,) = load_network_targets(self.env)
        self.assertEqual(
            (loaded.monitoring_interval_seconds, loaded.timeout_seconds, loaded.probe_count, loaded.enabled),
            (60, 2, 4, True),
        )

    def test_hostname_rules(self):
        for good in ("192.0.2.1", "::1", "2001:db8::1", "switch-1.example.com", "a"):
            with self.subTest(good=good):
                self.assertEqual(validate_hostname_or_ip(f" {good} "), good)
        for bad in (
            "",
            "   ",
            "-c",  # would be read as an option by ping
            "-evil.example.com",
            "host_name",
            "a..b",
            "a b",
            "host;rm",
            "$(x)",
            "host/path",
            "a" * 64 + ".example.com",  # label over 63 characters
            "a." * 130 + "com",  # over 253 characters
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError):
                    validate_hostname_or_ip(bad)

    def test_a_missing_file_and_a_directory_are_refused(self):
        with self.assertRaises(ConfigError):
            load_network_targets(self.env)
        with self.assertRaises(ConfigError):
            load_network_targets({ENV_NETWORK_TARGETS_FILE: self._tmp.name})

    def test_json_that_is_not_the_expected_shape_is_refused(self):
        for text in ("[]", '{"targets": {}}', '{"nothing": []}', "{not json"):
            with self.subTest(text=text):
                self.path.write_text(text, encoding="utf-8")
                with self.assertRaises(ConfigError):
                    load_network_targets(self.env)

    # -- suspected bugs: raise something other than ConfigError ------------------------

    def test_a_file_that_is_not_utf8_is_a_config_error(self):
        self.path.write_bytes(b"\xff\xfe{\x00}")
        with self.assertRaises(ConfigError):
            load_network_targets(self.env)

    @unittest.skipIf(not hasattr(os, "getuid") or os.getuid() == 0, "needs a non-root POSIX user")
    def test_a_file_that_cannot_be_read_is_a_config_error(self):
        self.write([self.target()])
        os.chmod(self.path, 0)
        self.addCleanup(os.chmod, self.path, 0o600)
        with self.assertRaises(ConfigError):
            load_network_targets(self.env)


if __name__ == "__main__":
    unittest.main()
