"""deploy/systemd/enable-unprivileged-icmp.sh: allows unprivileged ICMP for the
agent's group only, and never narrows or replaces an existing range.

Runs the real script with a fake ``getent``/``sysctl`` and a fake
``/proc/sys/net/ipv4/ping_group_range`` (works on any POSIX system)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "systemd" / "enable-unprivileged-icmp.sh"
AGENT_GID = 987


class EnableUnprivilegedIcmpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.sysctl_log = self.tmp / "sysctl.log"
        self._fake(
            "getent",
            f'[ "$1" = group ] && [ "$2" = sentinel-agent ] && '
            f'echo "sentinel-agent:x:{AGENT_GID}:" && exit 0\nexit 2',
        )
        self._fake("sysctl", f'echo "$@" >> "{self.sysctl_log}"')
        self.range_file = self.tmp / "ping_group_range"
        self.conf = self.tmp / "60-ssphere-sentinel-agent-icmp.conf"

    def _fake(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)

    def run_script(self, kernel_range: str, *args: str) -> subprocess.CompletedProcess:
        # The kernel separates the two values with a tab.
        self.range_file.write_text(kernel_range.replace(" ", "\t") + "\n")
        env = {
            "PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
            "PING_GROUP_RANGE_FILE": str(self.range_file),
            "SENTINEL_ICMP_SYSCTL_CONF": str(self.conf),
        }
        return subprocess.run(
            ["/bin/sh", str(SCRIPT), *args], env=env, capture_output=True, text=True, check=False
        )

    def sysctl_calls(self) -> list[str]:
        return self.sysctl_log.read_text().splitlines() if self.sysctl_log.exists() else []

    def test_disabled_range_allows_exactly_the_agent_group(self):
        # Debian/Ubuntu default: no group may open ICMP sockets.
        result = self.run_script("1 0")
        self.assertEqual(result.returncode, 0, result.stderr)
        settings = [
            line for line in self.conf.read_text().splitlines() if not line.startswith("#")
        ]
        self.assertEqual(settings, [f"net.ipv4.ping_group_range = {AGENT_GID} {AGENT_GID}"])
        self.assertEqual(self.sysctl_calls(), [f"-q -p {self.conf}"])

    def test_range_that_already_includes_the_group_is_left_alone(self):
        for kernel_range in ("0 2147483647", f"{AGENT_GID} {AGENT_GID}", f"{AGENT_GID - 1} {AGENT_GID + 1}"):
            with self.subTest(kernel_range=kernel_range):
                result = self.run_script(kernel_range)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("already allowed", result.stdout)
                self.assertFalse(self.conf.exists())
                self.assertEqual(self.sysctl_calls(), [])

    def test_other_configured_range_is_never_replaced(self):
        result = self.run_script("100 200")
        self.assertEqual(result.returncode, 1)
        self.assertIn("extend the range", result.stderr)
        self.assertFalse(self.conf.exists())
        self.assertEqual(self.sysctl_calls(), [])

    def test_second_run_is_a_no_op(self):
        self.assertEqual(self.run_script("1 0").returncode, 0)
        written = self.conf.read_text()
        # The kernel now reports the applied range.
        result = self.run_script(f"{AGENT_GID} {AGENT_GID}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already allowed", result.stdout)
        self.assertEqual(self.conf.read_text(), written)
        self.assertEqual(len(self.sysctl_calls()), 1)

    def test_unknown_group_fails_without_changes(self):
        result = self.run_script("1 0", "no-such-group")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", result.stderr)
        self.assertFalse(self.conf.exists())
        self.assertEqual(self.sysctl_calls(), [])


if __name__ == "__main__":
    unittest.main()
