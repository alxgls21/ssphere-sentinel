"""scripts/install.sh against stand-ins for docker, curl, uname and ss, with real bundles made by
.github/scripts/release_bundle.py: a new installation in each way it is reached, the download and its check,
what it refuses, an interrupted first start, and updates (the backup first, never an older release)."""

from __future__ import annotations

import importlib.util
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.deployment.helpers import write_executable

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "install.sh"
BASH = shutil.which("bash") or "/bin/bash"
SPEC = importlib.util.spec_from_file_location("release_bundle", ROOT / ".github" / "scripts" / "release_bundle.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

SERVER = "ghcr.io/alxgls21/ssphere-sentinel@sha256:" + "a" * 64
PROXY = "ghcr.io/alxgls21/ssphere-sentinel-proxy@sha256:" + "b" * 64
TOKEN = "eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYiLCJzIjoieHl6In0="
CODE = "K7QX-M2P9-A4TR"

FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
    "version --format {{.Server.Version}}") echo "$FAKE_ENGINE" ;;
    "compose version --short") echo "$FAKE_COMPOSE" ;;
    "compose config") printf 'name: sentinel\\nservices: {}\\n' ;;
    "compose config --volumes") echo postgres18_data ;;
    "volume ls --quiet") for volume in $FAKE_VOLUMES; do echo "$volume"; done ;;
    "volume inspect --format {{.CreatedAt}} "*) echo "2026-01-01 00:00:00 +0000 UTC" ;;
    "compose pull --quiet") ;;
    "compose up --detach --wait --wait-timeout 600") [ -z "$FAKE_UP_FAILS" ] || exit 1 ;;
    "compose up --detach --wait --wait-timeout 300 db") ;;
    "compose exec -T db sh -c "*) echo "PGDMP the dump" ;;
    "compose logs --no-color web") [ -z "$FAKE_CODE" ] || echo "web-1  | setup:     $FAKE_CODE" ;;
    *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
"""
# curl -fsSL --proto =https --tlsv1.2 -o FILE URL: the release's files from FAKE_RELEASES/<tag or latest>/.
FAKE_CURL = """#!/bin/sh
echo "curl $*" >> "$FAKE_LOG"
output=""
while [ $# -gt 1 ]; do
    if [ "$1" = -o ]; then output=$2; shift; fi
    shift
done
url=$1
case "$url" in
    https://github.com/alxgls21/ssphere-sentinel/releases/latest/download/*) path="latest/${url##*/}" ;;
    https://github.com/alxgls21/ssphere-sentinel/releases/download/*) rest=${url#*/releases/download/}; path="${rest%%/*}/${url##*/}" ;;
    *) exit 22 ;;
esac
[ -f "$FAKE_RELEASES/$path" ] || exit 22
cp "$FAKE_RELEASES/$path" "$output"
"""


class InstallScriptTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.dir = self.base / "opt" / "ssphere-sentinel"
        self.releases = self.base / "releases"
        bin_directory = self.base / "bin"
        bin_directory.mkdir()
        write_executable(bin_directory / "docker", FAKE_DOCKER)
        write_executable(bin_directory / "curl", FAKE_CURL)
        write_executable(bin_directory / "uname", '#!/bin/sh\necho Linux\n')
        write_executable(bin_directory / "ss", '#!/bin/sh\nprintf "%s\\n" "$FAKE_LISTENING"\n')
        self.log = self.base / "calls.log"
        self.environment = {
            "PATH": f"{bin_directory}{os.pathsep}{os.environ['PATH']}",
            "FAKE_LOG": str(self.log),
            "FAKE_ENGINE": "27.3.1",
            "FAKE_COMPOSE": "2.29.7",
            "FAKE_VOLUMES": "",
            "FAKE_UP_FAILS": "",
            "FAKE_CODE": CODE,
            "FAKE_LISTENING": "State Recv-Q Send-Q Local Address:Port",
            "FAKE_RELEASES": str(self.releases),
        }

    def publish(self, version: str, *tags: str) -> Path:
        """A release of ``version``, published under each of ``tags`` (vX.Y.Z, latest)."""
        out = self.base / "built" / version
        release.bundle(version, SERVER, PROXY, out)
        for tag in tags or (f"v{version}",):
            folder = self.releases / tag
            folder.mkdir(parents=True, exist_ok=True)
            for path in out.iterdir():
                (folder / path.name).write_bytes(path.read_bytes())
        return out

    def install(self, *args: str, **environment) -> subprocess.CompletedProcess:
        self.log.write_text("")
        result = subprocess.run(
            [BASH, str(SCRIPT), "--dir", str(self.dir), *args], cwd=self.base, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, env={**self.environment, **environment}, timeout=60, check=False,
        )
        self.output = result.stdout + result.stderr
        self.calls = self.log.read_text().splitlines()
        return result

    def local(self, version: str) -> tuple[str, ...]:
        out = self.publish(version)
        return ("--bundle", str(out / f"sentinel-{version}.tar.gz"), "--checksums", str(out / "SHA256SUMS"))

    def env(self) -> dict[str, str]:
        return dict(line.split("=", 1) for line in (self.dir / ".env").read_text().splitlines() if not line.startswith("#"))

    def mode(self, name: str) -> int:
        return stat.S_IMODE((self.dir / name).stat().st_mode)

    def assertRefused(self, result, words):
        self.assertNotEqual(result.returncode, 0, self.output)
        self.assertIn(words, self.output)
        self.assertNotIn("compose up --detach --wait --wait-timeout 600", self.calls)

    # --- a new installation

    def test_behind_a_reverse_proxy(self):
        result = self.install(*self.local("0.1.0"), "--url", "https://sentinel.example.com", "--proxy", "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual(self.env(), {"SENTINEL_URL": "https://sentinel.example.com", "SENTINEL_POSTGRES": "18",
                                      "SENTINEL_HTTP_BIND": "127.0.0.1", "SENTINEL_HTTP_PORT": "8000"})
        self.assertEqual(self.mode(".env"), 0o600)
        self.assertEqual((self.dir / ".sentinel-release").read_text().strip(), "0.1.0")
        for name in ("compose.yml", "compose.tunnel.yml", ".env.example", "deploy/postgres/postgres-18.yml"):
            self.assertTrue((self.dir / name).is_file(), name)
        self.assertEqual(self.mode("scripts/postgres-preflight.sh"), 0o755)
        self.assertFalse((self.dir / ".env.tunnel").exists())
        # The volumes checked, then the images, then the start.
        order = [self.calls.index(call) for call in ("volume ls --quiet", "compose pull --quiet",
                                                       "compose up --detach --wait --wait-timeout 600")]
        self.assertEqual(order, sorted(order))
        self.assertIn(f"    {CODE}", self.output)
        self.assertIn("reverse_proxy 127.0.0.1:8000", self.output)

    def test_through_cloudflare_tunnel(self):
        token_file = self.base / "token"
        token_file.write_text(TOKEN + "\n")
        result = self.install(*self.local("0.1.0"), "--url", "https://sentinel.example.com",
                              "--tunnel-token-file", str(token_file), "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.dir / ".env.tunnel").read_text(), f"TUNNEL_TOKEN={TOKEN}\n")
        self.assertEqual(self.mode(".env.tunnel"), 0o600)
        self.assertEqual(self.env()["COMPOSE_FILE"], "compose.yml:compose.tunnel.yml")
        self.assertNotIn(TOKEN, self.output + (self.dir / ".env").read_text())
        self.assertIn("http://proxy:8080", self.output)

    def test_on_the_local_network(self):
        result = self.install(*self.local("0.1.0"), "--url", "http://192.168.1.10:8080", "--local",
                              "--port", "8080", "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.env()["SENTINEL_HTTP_BIND"], self.env()["SENTINEL_HTTP_PORT"]), ("0.0.0.0", "8080"))
        self.assertIn("plain HTTP", self.output)

    def test_the_latest_release_or_a_chosen_one_is_downloaded(self):
        self.publish("0.1.0", "v0.1.0")
        self.publish("0.2.0", "v0.2.0", "latest")
        result = self.install("--url", "https://sentinel.example.com", "--proxy", "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.dir / ".sentinel-release").read_text().strip(), "0.2.0")
        self.assertTrue(any("releases/latest/download/sentinel-0.2.0.tar.gz" in call for call in self.calls))
        self.assertTrue(all("--proto =https" in call for call in self.calls if call.startswith("curl")))

    def test_a_chosen_release_that_does_not_exist_is_refused(self):
        self.publish("0.1.0")
        self.assertRefused(self.install("--version", "0.9.0", "--url", "https://s.example.com", "--proxy", "--yes"),
                           "cannot download the release 0.9.0")
        self.assertFalse(self.dir.exists())

    def test_a_bundle_that_does_not_match_its_checksum_is_not_installed(self):
        bundle, sums = self.local("0.1.0")[1], self.local("0.1.0")[3]
        with open(bundle, "ab") as stream:
            stream.write(b"tampered")
        self.assertRefused(self.install("--bundle", bundle, "--checksums", sums, "--url", "https://s.example.com",
                                        "--proxy", "--yes"), "does not match the release's SHA-256")
        self.assertFalse(self.dir.exists())

    def test_what_is_refused_before_anything_is_written(self):
        cases = {
            "no way in": ((), "--tunnel, --proxy or --local"),
            "no address": (("--proxy",), "--url"),
            "not an address": (("--proxy", "--url", "sentinel"), "is not the address of a console"),
            "a path": (("--proxy", "--url", "https://s.example.com/console"), "is not the address of a console"),
            "http behind a proxy": (("--proxy", "--url", "http://s.example.com"), "the address is https://"),
            "no token": (("--tunnel", "--url", "https://s.example.com"), "--tunnel-token-file"),
            "a bad port": (("--proxy", "--url", "https://s.example.com", "--port", "99999"), "port number"),
        }
        for name, (args, words) in cases.items():
            with self.subTest(name):
                self.assertRefused(self.install(*self.local("0.1.0"), *args, "--yes"), words)
                self.assertFalse((self.dir / ".env").exists())

    def test_a_port_in_use_is_refused(self):
        result = self.install(*self.local("0.1.0"), "--url", "https://s.example.com", "--proxy", "--yes",
                              FAKE_LISTENING="LISTEN 0 4096 0.0.0.0:8000 0.0.0.0:*")
        self.assertRefused(result, "port 8000 is in use")

    def test_a_missing_tool_is_named(self):
        bin_directory = self.base / "bin"
        result = self.install(*self.local("0.1.0"), "--url", "https://s.example.com", "--proxy", "--yes",
                              PATH=f"{bin_directory}{os.pathsep}/nonexistent")
        self.assertRefused(result, "is not installed")

    def test_an_old_docker_is_refused(self):
        for variables, words in (({"FAKE_ENGINE": "23.0.6"}, "Docker Engine 23.0.6 is too old"),
                                 ({"FAKE_COMPOSE": "2.20.3"}, "Docker Compose 2.20.3 is too old")):
            with self.subTest(words):
                self.assertRefused(self.install(*self.local("0.1.0"), "--url", "https://s.example.com", "--proxy",
                                                "--yes", **variables), words)

    def test_a_checkout_or_a_directory_of_something_else_is_never_touched(self):
        (self.dir / ".git").mkdir(parents=True)
        self.assertRefused(self.install(*self.local("0.1.0"), "--url", "https://s.example.com", "--proxy", "--yes"),
                           "is a checkout of the repository")
        (self.dir / ".git").rmdir()
        (self.dir / "notes.txt").write_text("mine")
        self.assertRefused(self.install(*self.local("0.1.0"), "--url", "https://s.example.com", "--proxy", "--yes"),
                           "is not empty")
        self.assertEqual(sorted(path.name for path in self.dir.iterdir()), ["notes.txt"])

    def test_an_interrupted_first_start_is_finished_by_the_same_command(self):
        args = self.local("0.1.0")
        self.assertNotEqual(self.install(*args, "--url", "https://s.example.com", "--proxy", "--yes",
                                         FAKE_UP_FAILS="1").returncode, 0)
        before = (self.dir / ".env").read_text()
        result = self.install(*args, "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertIn("already runs 0.1.0", self.output)
        self.assertEqual((self.dir / ".env").read_text(), before)
        self.assertIn("compose up --detach --wait --wait-timeout 600", self.calls)

    # --- updates

    def installed(self, version="0.1.0"):
        result = self.install(*self.local(version), "--url", "https://s.example.com", "--proxy", "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        (self.dir / "secrets").mkdir(exist_ok=True)
        (self.dir / "secrets" / "agent_token_pepper").write_text("kept\n")
        return (self.dir / ".env").read_text()

    def test_an_update_backs_up_first_and_keeps_the_settings(self):
        settings = self.installed("0.1.0")
        result = self.install(*self.local("0.2.0"), "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.dir / ".sentinel-release").read_text().strip(), "0.2.0")
        self.assertIn("SSphere Sentinel 0.2.0", (self.dir / "compose.yml").read_text())
        self.assertEqual((self.dir / ".env").read_text(), settings)
        self.assertEqual((self.dir / "secrets" / "agent_token_pepper").read_text(), "kept\n")
        backups = sorted(path.name for path in (self.dir / "backups").iterdir())
        self.assertEqual(len(backups), 2)
        self.assertTrue(backups[0].startswith("sentinel-0.1.0-") and backups[0].endswith(".dump"))
        self.assertTrue(backups[1].startswith("settings-0.1.0-") and backups[1].endswith(".tar.gz"))
        self.assertEqual(self.mode("backups"), 0o700)
        dump = self.calls.index(next(call for call in self.calls if call.startswith("compose exec -T db")))
        self.assertLess(dump, self.calls.index("compose pull --quiet"))
        listing = subprocess.run(["tar", "-tzf", str(self.dir / "backups" / backups[1])], capture_output=True,
                                 text=True, check=True).stdout.split()
        self.assertIn(".env", listing)
        self.assertIn("secrets/agent_token_pepper", listing)

    def test_an_update_without_a_backup(self):
        self.installed("0.1.0")
        result = self.install(*self.local("0.2.0"), "--no-backup", "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertFalse((self.dir / "backups").exists())

    def test_the_same_release_again_only_starts_it(self):
        self.installed("0.1.0")
        result = self.install(*self.local("0.1.0"), "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertFalse((self.dir / "backups").exists())
        self.assertIn("compose up --detach --wait --wait-timeout 600", self.calls)

    def test_a_release_never_goes_back(self):
        for installed, older in (("0.2.0", "0.1.0"), ("0.1.0", "0.1.0-rc.1"), ("0.1.0-rc.2", "0.1.0-rc.1"),
                                 ("0.10.0", "0.9.0")):
            with self.subTest(installed=installed, older=older):
                shutil.rmtree(self.dir, ignore_errors=True)
                self.installed(installed)
                self.assertRefused(self.install(*self.local(older), "--yes"), "a release never goes back")
                self.assertEqual((self.dir / ".sentinel-release").read_text().strip(), installed)

    def test_a_pre_release_goes_on_to_its_release(self):
        self.installed("0.1.0-rc.1")
        result = self.install(*self.local("0.1.0"), "--yes")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual((self.dir / ".sentinel-release").read_text().strip(), "0.1.0")


if __name__ == "__main__":
    unittest.main()
