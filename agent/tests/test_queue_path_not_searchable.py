"""A queue directory the agent may not search must not be an error when it looks for a backlog.

``Path.exists()`` re-raises ``PermissionError`` on Python 3.11 (which the agent supports) and answers ``False``
on newer interpreters. These tests make it raise, whichever interpreter runs them.
"""

import unittest
from pathlib import Path
from unittest.mock import patch

from agent.network_runtime import ENV_QUEUE_PATH, NetworkRuntime
from agent.snmp_runtime import SnmpRuntime

NOT_SEARCHABLE = PermissionError(13, "Permission denied")
ENVIRON = {ENV_QUEUE_PATH: "/var/lib/someone-else/queue.sqlite3"}


class QueuePathNotSearchableTests(unittest.TestCase):
    def test_the_network_runtime_finds_no_backlog_instead_of_failing(self):
        with patch.object(Path, "exists", side_effect=NOT_SEARCHABLE):
            self.assertIsNone(NetworkRuntime.from_environment(dict(ENVIRON)))

    def test_the_snmp_runtime_finds_no_backlog_instead_of_failing(self):
        with patch.object(Path, "exists", side_effect=NOT_SEARCHABLE):
            self.assertIsNone(SnmpRuntime.from_environment(dict(ENVIRON)))
