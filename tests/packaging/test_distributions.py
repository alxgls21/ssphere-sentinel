"""The agent and the server are separate distributions: monitored hosts must
never need Django, Gunicorn or a PostgreSQL driver.

Metadata checks always run. Build-and-install checks need network access
(build isolation, PyPI) and run only with SENTINEL_TEST_BUILD=1 (CI sets it).
"""

from __future__ import annotations

import ast
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = ROOT / "agent"
SERVER_ONLY = {"django", "gunicorn", "psycopg", "psycopg-binary", "whitenoise"}


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement_name(requirement: str) -> str:
    return canonical(re.split(r"[\s\[<>=!~;]", requirement.strip(), maxsplit=1)[0])


def load_project(path: Path) -> dict:
    return tomllib.loads(path.read_text())


class AgentMetadataTests(unittest.TestCase):
    def setUp(self):
        self.pyproject = load_project(AGENT_DIR / "pyproject.toml")
        self.project = self.pyproject["project"]

    def test_runtime_dependencies_are_agent_only(self):
        names = {requirement_name(req) for req in self.project["dependencies"]}
        self.assertEqual(names, {"psutil"})

    def test_docker_sdk_is_an_optional_extra(self):
        extras = self.project["optional-dependencies"]
        self.assertEqual({requirement_name(r) for r in extras["docker"]}, {"docker"})
        all_optional = {requirement_name(r) for reqs in extras.values() for r in reqs}
        self.assertFalse(all_optional & SERVER_ONLY)

    def test_cli_and_package_layout(self):
        self.assertEqual(self.project["name"], "ssphere-sentinel-agent")
        self.assertEqual(self.project["scripts"], {"sentinel-agent": "agent.cli:main"})
        setuptools = self.pyproject["tool"]["setuptools"]
        self.assertEqual(setuptools["packages"], ["agent"])  # tests/ is not shipped
        self.assertEqual(setuptools["package-dir"], {"agent": "."})

    def test_supported_python_versions_are_declared(self):
        self.assertEqual(self.project["requires-python"], ">=3.11")
        classifiers = set(self.project["classifiers"])
        for version in ("3.11", "3.12", "3.13", "3.14"):
            self.assertIn(f"Programming Language :: Python :: {version}", classifiers)

    def test_version_has_a_single_source(self):
        self.assertEqual(
            self.pyproject["tool"]["setuptools"]["dynamic"]["version"],
            {"attr": "agent.__version__"},
        )
        module = ast.parse((AGENT_DIR / "__init__.py").read_text())
        versions = [
            node.value.value
            for node in module.body
            if isinstance(node, ast.Assign)
            and any(getattr(t, "id", None) == "__version__" for t in node.targets)
        ]
        self.assertEqual(len(versions), 1)

    def test_license_text_ships_with_the_agent(self):
        self.assertEqual(
            (AGENT_DIR / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes()
        )


class ServerMetadataTests(unittest.TestCase):
    def setUp(self):
        self.pyproject = load_project(ROOT / "pyproject.toml")
        self.project = self.pyproject["project"]

    def test_server_dependencies(self):
        names = {requirement_name(req) for req in self.project["dependencies"]}
        self.assertEqual(names, {"django", "gunicorn", "psycopg", "whitenoise"})

    def test_server_distribution_does_not_ship_the_agent(self):
        include = self.pyproject["tool"]["setuptools"]["packages"]["find"]["include"]
        self.assertEqual(sorted(include), ["apps*", "sentinel*"])
        self.assertNotIn("scripts", self.project)


class ServerLockTests(unittest.TestCase):
    """requirements/server.txt pins every server dependency, with hashes."""

    def setUp(self):
        text = (ROOT / "requirements" / "server.txt").read_text()
        joined = re.sub(r"\\\n\s*", " ", text)
        self.pins = {}
        for line in joined.splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            match = re.match(r"^([A-Za-z0-9_.-]+)==(\S+)\s+(.*)$", line.strip())
            self.assertIsNotNone(match, f"not an exact, hashed pin: {line}")
            hashes = re.findall(r"--hash=sha256:([0-9a-f]{64})", match[3])
            self.assertTrue(hashes, f"no hashes for {match[1]}")
            self.pins[canonical(match[1])] = match[2]

    def test_every_server_dependency_is_pinned(self):
        project = load_project(ROOT / "pyproject.toml")["project"]
        for requirement in project["dependencies"]:
            self.assertIn(requirement_name(requirement), self.pins)
        self.assertIn("psycopg-binary", self.pins)  # psycopg[binary] extra

    def test_pins_satisfy_the_declared_ranges(self):
        try:
            from packaging.requirements import Requirement
        except ImportError:  # pragma: no cover - CI installs packaging
            self.skipTest("packaging is not installed")
        project = load_project(ROOT / "pyproject.toml")["project"]
        for raw in project["dependencies"]:
            requirement = Requirement(raw)
            pinned = self.pins[canonical(requirement.name)]
            self.assertIn(pinned, requirement.specifier, f"{requirement.name}=={pinned}")


@unittest.skipUnless(os.environ.get("SENTINEL_TEST_BUILD") == "1", "set SENTINEL_TEST_BUILD=1")
class BuildAndInstallTests(unittest.TestCase):
    """Build real wheels and install them into empty virtual environments."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="sentinel-packaging-"))
        # Build from copies so in-tree build artifacts never touch the checkout.
        agent_src = cls.tmp / "agent-src"
        shutil.copytree(AGENT_DIR, agent_src, ignore=shutil.ignore_patterns("__pycache__", "*.egg-info", "build"))
        server_src = cls.tmp / "server-src"
        server_src.mkdir()
        for name in ("pyproject.toml", "README.md", "LICENSE"):
            shutil.copy2(ROOT / name, server_src / name)
        for package in ("sentinel", "apps"):
            shutil.copytree(ROOT / package, server_src / package, ignore=shutil.ignore_patterns("__pycache__"))
        cls.agent_wheel = cls._build(agent_src, cls.tmp / "dist-agent")
        cls.server_wheel = cls._build(server_src, cls.tmp / "dist-server")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @staticmethod
    def _build(source: Path, outdir: Path) -> Path:
        subprocess.run(
            [sys.executable, "-m", "build", "--wheel", "--sdist", "--outdir", str(outdir), str(source)],
            check=True,
            capture_output=True,
        )
        (wheel,) = outdir.glob("*.whl")
        return wheel

    def _venv(self, name: str) -> Path:
        path = self.tmp / name
        venv.create(path, with_pip=True)
        return path / "bin"

    def _pip(self, bin_dir: Path, *args: str) -> str:
        return subprocess.run(
            [str(bin_dir / "python"), "-m", "pip", "--disable-pip-version-check", *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def test_agent_wheel_contents(self):
        with zipfile.ZipFile(self.agent_wheel) as wheel:
            names = wheel.namelist()
            metadata = wheel.read(next(n for n in names if n.endswith("/METADATA"))).decode()
            entry_points = wheel.read(next(n for n in names if n.endswith("/entry_points.txt"))).decode()
        packages = {name.split("/")[0] for name in names if not name.split("/")[0].endswith(".dist-info")}
        self.assertEqual(packages, {"agent"})
        self.assertFalse([n for n in names if "/tests/" in n or n.startswith("agent/tests")])
        self.assertIn("agent/network_targets.example.json", names)
        requires = sorted(line.split(": ", 1)[1] for line in metadata.splitlines() if line.startswith("Requires-Dist: "))
        self.assertEqual([requirement_name(r) for r in requires], ["docker", "psutil"])
        self.assertIn('extra == "docker"', next(r for r in requires if r.startswith("docker")))
        self.assertIn("sentinel-agent = agent.cli:main", entry_points)

    def test_server_wheel_contents(self):
        with zipfile.ZipFile(self.server_wheel) as wheel:
            packages = {name.split("/")[0] for name in wheel.namelist()}
        self.assertTrue({"sentinel", "apps"} <= packages)
        self.assertNotIn("agent", packages)

    def test_agent_installs_and_runs_without_server_dependencies(self):
        bin_dir = self._venv("agent-only")
        self._pip(bin_dir, "install", str(self.agent_wheel))
        installed = {
            canonical(line.split("==")[0])
            for line in self._pip(bin_dir, "list", "--format=freeze").splitlines()
        }
        self.assertEqual(installed - {"pip"}, {"psutil", "ssphere-sentinel-agent"})

        help_result = subprocess.run(
            [str(bin_dir / "sentinel-agent"), "--help"], capture_output=True, text=True, check=False
        )
        self.assertEqual(help_result.returncode, 0, help_result.stderr)

        # Nothing listens on the discard port: a clean failure, no traceback.
        env = {
            "PATH": os.environ.get("PATH", ""),
            "SENTINEL_URL": "http://127.0.0.1:9",
            "SENTINEL_AGENT_TOKEN": "packaging-test-token",
        }
        result = subprocess.run(
            [str(bin_dir / "sentinel-agent"), "heartbeat"],
            capture_output=True, text=True, check=False, env=env, cwd=self.tmp,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("Heartbeat failed", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("packaging-test-token", result.stderr + result.stdout)

    def test_docker_extra_installs_the_docker_sdk(self):
        bin_dir = self._venv("agent-docker")
        self._pip(bin_dir, "install", f"ssphere-sentinel-agent[docker] @ {self.agent_wheel.as_uri()}")
        result = subprocess.run(
            [str(bin_dir / "python"), "-c", "import docker, agent.docker_discovery"],
            capture_output=True, text=True, check=False, cwd=self.tmp,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
