import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

from agent.errors import ConfigError
from agent.snmp_config import (
    ENV_SNMP_CREDENTIALS_FILE,
    ENV_SNMP_DEVICES_FILE,
    load_credentials,
    load_devices,
    load_snmp_config,
)

DEVICE_ID = "0b8f0a5e-2f0e-4c1c-8f65-1e0d4f0d7d2a"
SECRET = "Sup3rS3cretValue-do-not-leak"


def device(**overrides):
    values = {"id": DEVICE_ID, "name": "core-sw-1", "address": "192.0.2.10", "credential_profile": "core"}
    values.update(overrides)
    return values


V3 = {
    "version": "3",
    "username": "sentinel",
    "auth_protocol": "SHA-256",
    "auth_password": SECRET + "-auth",
    "priv_protocol": "AES-128",
    "priv_password": SECRET + "-priv",
}


class ConfigTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        os.chmod(self.dir, 0o700)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, name, data, mode=0o600):
        path = self.dir / name
        path.write_text(json.dumps(data) if not isinstance(data, str) else data, encoding="utf-8")
        os.chmod(path, mode)
        return path

    def credentials(self, profiles=None, **kwargs):
        return self.write("credentials.json", {"profiles": profiles if profiles is not None else {"core": V3}}, **kwargs)

    def devices(self, devices=None):
        return self.write("devices.json", {"devices": devices if devices is not None else [device()]}, mode=0o644)

    def environment(self, **overrides):
        env = {
            ENV_SNMP_DEVICES_FILE: str(self.dir / "devices.json"),
            ENV_SNMP_CREDENTIALS_FILE: str(self.dir / "credentials.json"),
        }
        env.update(overrides)
        return env

    def assert_error(self, path_loader, text, *args):
        with self.assertRaises(ConfigError) as caught:
            path_loader(*args)
        self.assertIn(text, str(caught.exception))
        self.assertNotIn(SECRET, str(caught.exception))
        return str(caught.exception)


class DeviceTests(ConfigTestCase):
    def test_defaults_match_the_server(self):
        self.devices()
        loaded = load_devices(self.dir / "devices.json")[0]
        self.assertEqual(
            (loaded.port, loaded.poll_interval_seconds, loaded.timeout_seconds, loaded.retries, loaded.enabled),
            (161, 300, 5, 1, True),
        )
        self.assertEqual(loaded.discovery_interval_seconds, 6 * 3600)
        self.assertEqual(loaded.interfaces.max_interfaces, 256)
        self.assertEqual(str(loaded.id), DEVICE_ID)

    def test_overrides_and_interface_selection(self):
        self.devices(
            [
                device(
                    port=1161,
                    poll_interval_seconds=60,
                    timeout_seconds=3,
                    retries=2,
                    enabled=False,
                    discovery_interval_seconds=600,
                    interfaces={"include": ["Gi0/*"], "exclude": ["Gi0/48"], "max_interfaces": 24},
                )
            ]
        )
        loaded = load_devices(self.dir / "devices.json")[0]
        self.assertEqual((loaded.port, loaded.poll_interval_seconds, loaded.retries, loaded.enabled), (1161, 60, 2, False))
        self.assertEqual(loaded.interfaces.include, ("Gi0/*",))
        self.assertEqual(loaded.interfaces.exclude, ("Gi0/48",))
        self.assertEqual(loaded.interfaces.max_interfaces, 24)

    def test_invalid_devices_are_refused_with_a_location(self):
        cases = {
            "id must be a UUID": device(id="nope"),
            "name is invalid": device(name=""),
            "address": device(address="bad host;rm"),
            "credential_profile is invalid": device(credential_profile="has space"),
            "port must be between": device(port=0),
            "poll_interval_seconds must be between": device(poll_interval_seconds=29),
            "timeout_seconds must be between": device(timeout_seconds=0),
            "retries must be between": device(retries=6),
            "enabled must be a boolean": device(enabled="yes"),
            "must be an integer": device(port="161"),
            "unknown field(s): community": device(community="public"),
            "max_interfaces must be between": device(interfaces={"max_interfaces": 513}),
            "contains an invalid pattern": device(interfaces={"include": [""]}),
            "unknown field(s): exclude_types": device(interfaces={"exclude_types": [24]}),
        }
        for expected, item in cases.items():
            with self.subTest(expected):
                self.devices([item])
                self.assert_error(load_devices, expected, self.dir / "devices.json")

    def test_requests_must_fit_into_the_poll_interval(self):
        self.devices([device(poll_interval_seconds=30, timeout_seconds=15, retries=1)])
        self.assert_error(load_devices, "shorter than poll_interval_seconds", self.dir / "devices.json")
        self.devices([device(poll_interval_seconds=30, timeout_seconds=5, retries=1)])
        load_devices(self.dir / "devices.json")

    def test_duplicate_ids_and_too_many_devices(self):
        self.devices([device(), device(name="other")])
        self.assert_error(load_devices, "duplicate ids", self.dir / "devices.json")
        many = [device(id=f"00000000-0000-0000-0000-{i:012d}", name=f"d{i}") for i in range(201)]
        self.devices(many)
        self.assert_error(load_devices, "exceed the maximum", self.dir / "devices.json")

    def test_not_json_and_wrong_shapes(self):
        self.write("devices.json", "{not json", mode=0o644)
        self.assert_error(load_devices, "not valid JSON", self.dir / "devices.json")
        self.write("devices.json", "[]", mode=0o644)
        self.assert_error(load_devices, "must be an object", self.dir / "devices.json")
        self.write("devices.json", {"devices": {}}, mode=0o644)
        self.assert_error(load_devices, "'devices' list", self.dir / "devices.json")
        self.assert_error(load_devices, "readable file", self.dir / "missing.json")


class CredentialTests(ConfigTestCase):
    def test_v3_profile_with_sha2_and_aes(self):
        self.credentials()
        profile = load_credentials(self.dir / "credentials.json")["core"]
        self.assertEqual((profile.version, profile.auth_protocol, profile.priv_protocol), ("3", "SHA-256", "AES-128"))
        self.assertEqual(profile.security_level, "authPriv")

    def test_protocol_spellings_are_normalised(self):
        for spelling, expected in (("sha-512", "SHA-512"), ("SHA512", "SHA-512"), ("sha_384", "SHA-384"), ("SHA", "SHA"), ("sha1", "SHA")):
            with self.subTest(spelling):
                self.credentials({"core": {**V3, "auth_protocol": spelling}})
                self.assertEqual(load_credentials(self.dir / "credentials.json")["core"].auth_protocol, expected)
        for spelling, expected in (("aes", "AES-128"), ("AES-192", "AES-192"), ("aes256", "AES-256")):
            with self.subTest(spelling):
                self.credentials({"core": {**V3, "priv_protocol": spelling}})
                self.assertEqual(load_credentials(self.dir / "credentials.json")["core"].priv_protocol, expected)

    def test_auth_only_profile_is_allowed(self):
        profile = {k: v for k, v in V3.items() if not k.startswith("priv")}
        self.credentials({"core": profile})
        loaded = load_credentials(self.dir / "credentials.json")["core"]
        self.assertEqual((loaded.priv_protocol, loaded.security_level), ("", "authNoPriv"))

    def test_v2c_profile(self):
        self.credentials({"edge": {"version": "2c", "community": SECRET}})
        loaded = load_credentials(self.dir / "credentials.json")["edge"]
        self.assertEqual((loaded.version, loaded.community), ("2c", SECRET))

    def test_insecure_options_are_refused(self):
        cases = {
            "SNMPv1 is not supported": {"version": "1", "community": SECRET},
            "MD5 authentication is not supported": {**V3, "auth_protocol": "MD5"},
            "DES privacy is not supported": {**V3, "priv_protocol": "DES"},
            "3DES privacy is not supported": {**V3, "priv_protocol": "3DES"},
            "requires authentication": {k: v for k, v in V3.items() if not k.startswith(("auth", "priv"))},
            "priv_password is set without priv_protocol": {
                **{k: v for k, v in V3.items() if k != "priv_protocol"}
            },
            "auth_password must be at least 8 characters": {**V3, "auth_password": "short"},
            "priv_password must be at least 8 characters": {**V3, "priv_password": "short"},
            "priv_password is required": {k: v for k, v in V3.items() if k != "priv_password"},
            "version must be": {**V3, "version": "4"},
            "applies to SNMPv3 only": {"version": "2c", "community": SECRET, "username": "x"},
            "applies to SNMPv2c only": {**V3, "community": SECRET},
            "unknown field(s): priv_pasword": {**V3, "priv_pasword": SECRET},
            "username is required": {**V3, "username": ""},
        }
        for expected, profile in cases.items():
            with self.subTest(expected):
                self.credentials({"core": profile})
                self.assert_error(load_credentials, expected, self.dir / "credentials.json")

    def test_error_messages_never_contain_secret_values(self):
        bad = {**V3, "priv_pasword": SECRET, "auth_password": SECRET}
        self.credentials({"core": bad})
        message = self.assert_error(load_credentials, "unknown field(s)", self.dir / "credentials.json")
        self.assertNotIn(SECRET, message)
        self.write("credentials.json", '{"profiles": {"core": {"version": "2c", "community": "' + SECRET + '" bad}}}')
        message = self.assert_error(load_credentials, "not valid JSON", self.dir / "credentials.json")
        self.assertNotIn(SECRET, message)

    def test_invalid_profile_names_are_refused(self):
        self.credentials({"has space": V3})
        self.assert_error(load_credentials, "invalid profile name", self.dir / "credentials.json")

    def test_repr_never_shows_secrets(self):
        self.credentials()
        profile = load_credentials(self.dir / "credentials.json")["core"]
        self.assertNotIn(SECRET, repr(profile))
        self.assertNotIn(SECRET, str(profile))
        config = load_snmp_config(self.environment() if (self.devices() or True) else {})
        self.assertNotIn(SECRET, repr(config))

    def test_secrets_lists_every_secret(self):
        self.credentials()
        profile = load_credentials(self.dir / "credentials.json")["core"]
        self.assertEqual(set(profile.secrets()), {SECRET + "-auth", SECRET + "-priv"})


class CredentialFileSecurityTests(ConfigTestCase):
    def test_owner_only_and_group_readable_files_are_accepted(self):
        for mode in (0o600, 0o640, 0o400):
            with self.subTest(oct(mode)):
                self.credentials(mode=mode)
                load_credentials(self.dir / "credentials.json")

    def test_files_open_to_other_users_are_refused(self):
        for mode in (0o604, 0o644, 0o660, 0o666, 0o602):
            with self.subTest(oct(mode)):
                path = self.credentials(mode=mode)
                self.assert_error(load_credentials, "must not", path)

    def test_group_writable_files_are_refused(self):
        path = self.credentials(mode=0o620)
        self.assert_error(load_credentials, "must not be writable", path)

    def test_symlinks_are_refused(self):
        target = self.credentials(mode=0o600)
        link = self.dir / "link.json"
        link.symlink_to(target)
        self.assert_error(load_credentials, "cannot be opened", link)

    def test_directories_and_missing_files_are_refused(self):
        self.assert_error(load_credentials, "must be a regular file", self.dir)
        self.assert_error(load_credentials, "cannot be opened", self.dir / "missing.json")

    def test_a_fifo_at_the_path_is_refused_instead_of_blocking(self):
        fifo = self.dir / "credentials.json"
        os.mkfifo(fifo, 0o600)
        outcome = []

        def attempt():
            try:
                load_credentials(fifo)
            except ConfigError as exc:
                outcome.append(str(exc))

        thread = threading.Thread(target=attempt, daemon=True)
        thread.start()
        thread.join(5)
        self.assertFalse(thread.is_alive(), "opening the FIFO blocked")
        self.assertIn("must be a regular file", outcome[0])

    def test_oversized_files_are_refused(self):
        path = self.write("credentials.json", " " * 1_000_001)
        self.assert_error(load_credentials, "too large", path)


class EnvironmentTests(ConfigTestCase):
    def test_not_configured_means_none(self):
        self.assertIsNone(load_snmp_config({}))
        self.assertIsNone(load_snmp_config({ENV_SNMP_DEVICES_FILE: "  "}))

    def test_devices_need_credentials(self):
        self.devices()
        with self.assertRaises(ConfigError) as caught:
            load_snmp_config({ENV_SNMP_DEVICES_FILE: str(self.dir / "devices.json")})
        self.assertIn(ENV_SNMP_CREDENTIALS_FILE, str(caught.exception))

    def test_every_enabled_device_needs_its_profile(self):
        self.credentials({"other": V3})
        self.devices()
        self.assert_error(load_snmp_config, "is not defined", self.environment())

    def test_a_disabled_device_may_reference_a_missing_profile(self):
        self.credentials({"other": V3})
        self.devices([device(enabled=False)])
        config = load_snmp_config(self.environment())
        self.assertEqual(config.enabled_devices, ())
        self.assertEqual(len(config.devices), 1)

    def test_loads_both_files(self):
        self.credentials()
        self.devices()
        config = load_snmp_config(self.environment())
        self.assertEqual([d.name for d in config.enabled_devices], ["core-sw-1"])
        self.assertIn("core", config.credentials)


if __name__ == "__main__":
    unittest.main()
