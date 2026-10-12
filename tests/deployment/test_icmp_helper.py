"""deploy/systemd/enable-unprivileged-icmp.sh: allows unprivileged ICMP for the
agent's group only, never narrows or replaces an existing range, and verifies
that the kernel accepted the change.

Runs the real script with fake ``getent``/``sysctl`` commands and a fake
``/proc/sys/net/ipv4/ping_group_range`` (any POSIX system), under every
available POSIX shell (dash is Debian's and Ubuntu's ``/bin/sh``). On Linux it
also reads the real procfs file, which returns end-of-file for reads at a
non-zero offset: dash's byte-by-byte ``read`` builtin only ever saw "1" there.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "systemd" / "enable-unprivileged-icmp.sh"
PROC_RANGE = Path("/proc/sys/net/ipv4/ping_group_range")
AGENT_GID = 987

# Each distinct POSIX shell available here (on Debian/Ubuntu /bin/sh is dash).
SHELLS: list[str] = []
for _candidate in ("/bin/sh", shutil.which("dash")):
    if _candidate and os.path.realpath(_candidate) not in map(os.path.realpath, SHELLS):
        SHELLS.append(_candidate)


class HelperTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.sysctl_dir = self.tmp / "sysctl.d"
        self.sysctl_dir.mkdir()
        self.conf = self.sysctl_dir / "60-ssphere-sentinel-agent-icmp.conf"
        self.range_file = self.tmp / "ping_group_range"
        self.sysctl_log = self.tmp / "sysctl.log"
        self.fake_getent(f"sentinel-agent:x:{AGENT_GID}:")
        # sysctl -q -p FILE. Modes: apply (like the kernel), refuse (write
        # rejected), ignore (Ubuntu's sysctl: warns, exits 0, nothing applied).
        self.fake(
            "sysctl",
            f'echo "$@" >> "{self.sysctl_log}"\n'
            'case "$FAKE_SYSCTL_MODE" in\n'
            '  refuse) echo "sysctl: setting key \\"net.ipv4.ping_group_range\\": Invalid argument" >&2; exit 1 ;;\n'
            '  ignore) echo "sysctl: permission denied on key \\"net.ipv4.ping_group_range\\", ignoring" >&2; exit 0 ;;\n'
            '  apply) sed -n "s/^net.ipv4.ping_group_range = //p" "$3" | tr " " "\\t" > "$FAKE_RANGE_FILE" ;;\n'
            "esac",
        )

    def fake(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)

    def fake_getent(self, line: str) -> None:
        self.fake("getent", f'[ "$1" = group ] && [ "$2" = sentinel-agent ] && echo "{line}" && exit 0\nexit 2')

    def set_range(self, content: str) -> None:
        self.range_file.write_text(content)

    def run_helper(
        self, shell: str, *args: str, sysctl_mode: str = "apply", range_file: Path | None = None
    ) -> subprocess.CompletedProcess:
        env = {
            "PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin",
            "PING_GROUP_RANGE_FILE": str(range_file or self.range_file),
            "SENTINEL_ICMP_SYSCTL_CONF": str(self.conf),
            "SENTINEL_SYSCTL_CONF_DIRS": str(self.sysctl_dir),
            "FAKE_SYSCTL_MODE": sysctl_mode,
            "FAKE_RANGE_FILE": str(self.range_file),
        }
        return subprocess.run(
            [shell, str(SCRIPT), *args], env=env, capture_output=True, text=True, check=False
        )

    def sysctl_calls(self) -> list[str]:
        return self.sysctl_log.read_text().splitlines() if self.sysctl_log.exists() else []

    def reset(self) -> None:
        for path in (self.conf, self.sysctl_log):
            path.unlink(missing_ok=True)

    def assert_unchanged(self, result: subprocess.CompletedProcess, message: str) -> None:
        """Failed visibly, wrote no drop-in and never called sysctl."""
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.conf.exists())
        self.assertEqual(self.sysctl_calls(), [])

    def for_each_shell(self):
        for shell in SHELLS:
            with self.subTest(shell=shell):
                self.reset()
                yield shell


class EnableUnprivilegedIcmpTests(HelperTestCase):
    def test_disabled_range_allows_exactly_the_agent_group(self):
        # Debian/Ubuntu default: no group may open ICMP sockets.
        for shell in self.for_each_shell():
            self.set_range("1\t0\n")
            result = self.run_helper(shell)
            self.assertEqual(result.returncode, 0, result.stderr)
            settings = [line for line in self.conf.read_text().splitlines() if not line.startswith("#")]
            self.assertEqual(settings, [f"net.ipv4.ping_group_range = {AGENT_GID} {AGENT_GID}"])
            self.assertEqual(self.sysctl_calls(), [f"-q -p {self.conf}"])
            # Verified against what the kernel reports after applying it.
            self.assertEqual(self.range_file.read_text(), f"{AGENT_GID}\t{AGENT_GID}\n")
            self.assertIn("unprivileged ICMP allowed", result.stdout)

    def test_missing_trailing_newline_is_read_correctly(self):
        for shell in self.for_each_shell():
            self.set_range("1\t0")
            result = self.run_helper(shell)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(self.conf.exists())
        for shell in self.for_each_shell():
            self.set_range(f"0\t{2**31 - 1}")
            result = self.run_helper(shell)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already allowed", result.stdout)

    def test_existing_permitted_range_is_left_alone(self):
        ranges = ("0 2147483647", f"{AGENT_GID} {AGENT_GID}", f"{AGENT_GID - 1} {AGENT_GID + 1}")
        for kernel_range in ranges:
            for shell in self.for_each_shell():
                with self.subTest(kernel_range=kernel_range):
                    self.set_range(kernel_range.replace(" ", "\t") + "\n")
                    result = self.run_helper(shell)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(f"already allowed for sentinel-agent (gid {AGENT_GID}): ping_group_range = {kernel_range}", result.stdout)
                    self.assertFalse(self.conf.exists())
                    self.assertEqual(self.sysctl_calls(), [])

    def test_other_active_range_is_never_replaced(self):
        for shell in self.for_each_shell():
            self.set_range("100\t200\n")
            self.assert_unchanged(self.run_helper(shell), "extend the range to cover gid 987")
            self.assertEqual(self.range_file.read_text(), "100\t200\n")

    def test_range_configured_in_another_sysctl_file_is_never_overridden(self):
        # Not active yet, but systemd-sysctl would apply it at boot, and our
        # 60- drop-in would then override it.
        settings = (
            "-net.ipv4.ping_group_range = 0 2147483647",
            "net/ipv4/ping_group_range=0 2147483647",
            "  net.ipv4.ping_group_range = 100 200",
        )
        for setting in settings:
            for shell in self.for_each_shell():
                with self.subTest(setting=setting):
                    other = self.sysctl_dir / "50-default.conf"
                    other.write_text(f"# distribution defaults\n{setting}\n")
                    self.set_range("1\t0\n")
                    self.assert_unchanged(self.run_helper(shell), f"{other} already configures")
                    other.unlink()

    def test_commented_settings_and_our_own_drop_in_do_not_block(self):
        for shell in self.for_each_shell():
            (self.sysctl_dir / "10-notes.conf").write_text("# net.ipv4.ping_group_range = 0 2147483647\n")
            self.conf.write_text(f"net.ipv4.ping_group_range = {AGENT_GID} {AGENT_GID}\n")  # earlier run
            self.set_range("1\t0\n")  # e.g. reset at runtime since
            result = self.run_helper(shell)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(self.sysctl_calls()), 1)

    def test_malformed_or_empty_values_are_rejected(self):
        values = {
            "empty": "",
            "only a newline": "\n",
            "blank": "   \n",
            "first byte only (old dash/procfs symptom)": "1",
            "one value": "1\t\n",
            "letters": "abc\t0\n",
            "second value not a number": "1\tx\n",
            "negative": "-1\t0\n",
            "decimal": "1.5\t2\n",
            "three values": "1\t0\t5\n",
            "two lines": "1\t0\n2\t3\n",
            "too many digits": "99999999999\t0\n",
            "glob characters": "*\t?\n",
        }
        for label, content in values.items():
            for shell in self.for_each_shell():
                with self.subTest(value=label):
                    self.set_range(content)
                    self.assert_unchanged(self.run_helper(shell), "unexpected net.ipv4.ping_group_range value")

    def test_unreadable_range_file_fails_visibly(self):
        for shell in self.for_each_shell():
            result = self.run_helper(shell, range_file=self.tmp / "missing")
            self.assert_unchanged(result, "cannot read")

    def test_failed_sysctl_application_leaves_nothing_behind(self):
        for shell in self.for_each_shell():
            self.set_range("1\t0\n")
            result = self.run_helper(shell, sysctl_mode="refuse")
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("could not apply", result.stderr)
            self.assertFalse(self.conf.exists())
            self.assertEqual(self.range_file.read_text(), "1\t0\n")

    def test_sysctl_success_without_effect_is_detected(self):
        # Ubuntu's sysctl exits 0 when the write is refused (containers).
        for shell in self.for_each_shell():
            self.set_range("1\t0\n")
            result = self.run_helper(shell, sysctl_mode="ignore")
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("is still '1 0' after applying it", result.stderr)
            self.assertFalse(self.conf.exists())
            self.assertNotIn("unprivileged ICMP allowed", result.stdout)

    def test_second_run_is_a_no_op(self):
        for shell in self.for_each_shell():
            self.set_range("1\t0\n")
            self.assertEqual(self.run_helper(shell).returncode, 0)
            written = self.conf.read_text()
            result = self.run_helper(shell)  # the kernel now reports the applied range
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already allowed", result.stdout)
            self.assertEqual(self.conf.read_text(), written)
            self.assertEqual(len(self.sysctl_calls()), 1)

    def test_unknown_group_or_unexpected_gid_fails_without_changes(self):
        for shell in self.for_each_shell():
            self.set_range("1\t0\n")
            self.assert_unchanged(self.run_helper(shell, "no-such-group"), "does not exist")
        self.fake_getent("sentinel-agent:x:not-a-number:")
        for shell in self.for_each_shell():
            self.assert_unchanged(self.run_helper(shell), "unexpected gid")


@unittest.skipUnless(PROC_RANGE.exists(), "needs Linux procfs")
class RealProcfsTests(HelperTestCase):
    """Reads the real /proc/sys/net/ipv4/ping_group_range (never writes it)."""

    def test_helper_parses_the_real_procfs_file(self):
        low, high = (int(value) for value in PROC_RANGE.read_text().split())
        for shell in self.for_each_shell():
            if low <= high:
                # A range is active: use a gid inside it.
                self.fake_getent(f"sentinel-agent:x:{low}:")
                result = self.run_helper(shell, range_file=PROC_RANGE, sysctl_mode="record")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"ping_group_range = {low} {high}", result.stdout)
            else:
                # Disabled (Debian/Ubuntu default). The fake sysctl changes
                # nothing, so the post-apply check must report both values.
                result = self.run_helper(shell, range_file=PROC_RANGE, sysctl_mode="record")
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(f"is still '{low} {high}' after applying it", result.stderr)
                self.assertEqual(self.sysctl_calls(), [f"-q -p {self.conf}"])
                self.assertFalse(self.conf.exists())
            self.assertEqual(PROC_RANGE.read_text().split(), [str(low), str(high)])


if __name__ == "__main__":
    unittest.main()
