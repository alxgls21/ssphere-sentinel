import os
import tempfile
import threading
from datetime import timedelta
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.test import TransactionTestCase
from django.utils import timezone

from apps.alerts.runtime import alive
from apps.core.management.commands import run_maintenance
from apps.core.management.commands.run_maintenance import TASKS, run_tasks

COMMAND = "apps.core.management.commands.run_maintenance"


class MaintenanceTests(TransactionTestCase):
    def test_every_cleanup_the_guide_lists_runs(self):
        self.assertEqual(set(TASKS), {
            "purge_network_measurements", "purge_snmp_data", "purge_telemetry_samples",
            "purge_absent_docker_containers", "purge_incidents", "purge_notifications", "purge_audit_entries",
            "clearsessions",
        })

    def test_once_runs_each_cleanup_with_its_own_retention(self):
        from django.contrib.sessions.models import Session

        Session.objects.create(session_key="old", session_data="", expire_date=timezone.now() - timedelta(days=1))
        with self.assertLogs("apps.core.maintenance", "INFO") as logs:
            call_command("run_maintenance", "--once")
        self.assertFalse(Session.objects.filter(session_key="old").exists())
        output = "\n".join(logs.output)
        for name in TASKS:
            self.assertIn(f"maintenance: {name}:", output)

    def test_a_failing_cleanup_does_not_stop_the_others(self):
        real = run_maintenance.call_command
        ran = []

        def fake(name, **kwargs):
            ran.append(name)
            if name == "purge_snmp_data":
                raise RuntimeError("boom")
            return real(name, **kwargs)

        with patch(f"{COMMAND}.call_command", side_effect=fake), self.assertLogs("apps.core.maintenance", "INFO"):
            self.assertEqual(run_tasks(), ["purge_snmp_data"])
            with self.assertRaisesRegex(CommandError, "Failed: purge_snmp_data"):
                call_command("run_maintenance", "--once")
        self.assertEqual(ran[: len(TASKS)], list(TASKS))

    def test_it_never_migrates(self):
        with patch(f"{COMMAND}.unapplied_migrations", return_value=[("core", "9999_future")]):
            with self.assertRaisesRegex(CommandError, "never migrates"):
                call_command("run_maintenance", "--once")

    def test_the_interval_is_bounded(self):
        for value in ("3599", str(7 * 86400 + 1)):
            with self.subTest(value=value), self.assertRaisesRegex(CommandError, "--interval"):
                call_command("run_maintenance", "--once", "--interval", value)

    def test_a_stop_ends_the_run_and_the_liveness_file_is_kept(self):
        stop = threading.Event()
        stop.set()
        with tempfile.TemporaryDirectory() as folder:
            liveness = os.path.join(folder, "alive")
            self.assertEqual(run_tasks(stop, liveness=liveness), [])
            self.assertFalse(os.path.exists(liveness))  # stopped before the first cleanup
            with self.assertLogs("apps.core.maintenance", "INFO"):
                run_tasks(liveness=liveness)
            self.assertTrue(alive(liveness))
