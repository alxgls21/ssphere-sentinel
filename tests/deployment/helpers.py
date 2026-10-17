"""Shared fixtures for deployment checks that run without Docker."""

import re
import stat
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def logical_lines(text: str) -> list[str]:
    """Shell lines with backslash continuations joined."""
    return re.sub(r"\\\n\s*", " ", text).splitlines()


def write_executable(path: Path, text: str) -> None:
    """Install a stand-in command, preserving its existing permission bits."""
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def load_workflow(test: unittest.TestCase) -> dict:
    try:
        import yaml
    except ImportError:  # pragma: no cover - CI installs PyYAML
        test.skipTest("PyYAML is not installed")
    return yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text())
