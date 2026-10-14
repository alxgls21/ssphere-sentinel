"""The Server job of .github/workflows/ci.yml installs what the server tests need.

Some server tests run the real agent against the live test server
(apps/snmp/tests/test_agent_*.py, apps/agents/tests/test_request_body_limit.py).
The agent is its own distribution and needs ``psutil``, which the server
neither has nor should have: a cell that installs only the server fails on the
import of ``agent.telemetry``. The agent therefore belongs to the *test*
environment of every cell, and never to the server's dependencies.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def server_tests_that_import_the_agent() -> list[str]:
    pattern = re.compile(r"^\s*(?:from|import) +agent(?:[. ]|$)", re.M)
    return sorted(
        str(path.relative_to(ROOT))
        for path in (ROOT / "apps").rglob("test*.py")
        if pattern.search(path.read_text())
    )


class ServerJobTests(unittest.TestCase):
    def setUp(self):
        try:
            import yaml
        except ImportError:  # pragma: no cover - CI installs PyYAML
            self.skipTest("PyYAML is not installed")
        workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text())
        self.job = workflow["jobs"]["server"]
        self.steps = self.job["steps"]

    def step_index(self, predicate) -> int:
        return next(i for i, step in enumerate(self.steps) if predicate(step))

    def test_the_server_tests_that_run_the_agent_exist(self):
        # The rule below is about these tests; if they are gone, so is the need.
        tests = server_tests_that_import_the_agent()
        self.assertIn("apps/snmp/tests/test_agent_request_budget.py", tests)

    def test_every_matrix_cell_installs_the_agent_before_the_tests(self):
        installs = [
            i
            for i, step in enumerate(self.steps)
            if "if" not in step and re.search(r"pip install\s+.*\./agent\b", step.get("run", ""))
        ]
        self.assertTrue(
            installs,
            "no step without a condition installs ./agent: the cells that skip it cannot import agent.telemetry (psutil)",
        )
        tests = self.step_index(lambda step: step.get("run", "").strip() == "python manage.py test apps")
        self.assertLess(installs[0], tests)

    def test_the_server_is_installed_without_the_agents_dependency(self):
        (server,) = [step for step in self.steps if step.get("name") == "Install the server"]
        # The server's own install stays the server's: psutil is not smuggled in with it.
        self.assertNotIn("psutil", server["run"])
        self.assertNotIn("./agent", server["run"])

    def test_the_server_does_not_depend_on_psutil(self):
        # psutil is the agent's requirement (agent/pyproject.toml). The server
        # distribution and the image's hash-pinned lock must stay free of it;
        # tests/packaging pins the exact dependency set.
        for path in ("pyproject.toml", "requirements/server.txt"):
            with self.subTest(path=path):
                self.assertNotRegex((ROOT / path).read_text().lower(), r"\bpsutil\b")
        self.assertIn("psutil", (ROOT / "agent" / "pyproject.toml").read_text())


if __name__ == "__main__":
    unittest.main()
