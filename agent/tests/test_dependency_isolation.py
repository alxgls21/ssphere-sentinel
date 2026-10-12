"""The agent must work on hosts without any server-side dependency and
without the optional Docker SDK."""

import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BLOCKED = ("django", "gunicorn", "psycopg", "psycopg_binary", "whitenoise", "docker")

SCRIPT = textwrap.dedent(
    """
    import importlib
    import importlib.abc
    import pkgutil
    import sys

    BLOCKED = set(sys.argv[1].split(","))

    class Block(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name.split(".")[0] in BLOCKED:
                raise ModuleNotFoundError(f"No module named {name!r}", name=name)
            return None

    sys.meta_path.insert(0, Block())

    import agent

    for module in pkgutil.iter_modules(agent.__path__):
        if module.name not in ("tests", "__main__"):  # __main__ runs the CLI
            importlib.import_module(f"agent.{module.name}")

    from agent.docker_discovery import collect_docker

    payload = collect_docker()
    assert payload["available"] is False, payload
    assert payload["status"] == "unavailable", payload

    from agent.cli import main

    try:
        main(["--help"])
    except SystemExit as exc:
        assert exc.code == 0, exc.code
    leaked = sorted(name for name in sys.modules if name.split(".")[0] in BLOCKED)
    assert not leaked, leaked
    print("isolated-ok")
    """
)


class DependencyIsolationTests(unittest.TestCase):
    def test_agent_runs_without_server_dependencies_or_docker_sdk(self):
        result = subprocess.run(
            [sys.executable, "-c", SCRIPT, ",".join(BLOCKED)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("isolated-ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
