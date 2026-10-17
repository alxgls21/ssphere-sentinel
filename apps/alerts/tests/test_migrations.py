"""The alerts migrations: the default rules, and installing and removing the app."""

import importlib
import logging
import threading
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps as django_apps
from django.core.management import CommandError, call_command
from django.db import connection, migrations
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, override_settings

from apps.alerts.models import AlertRule
from apps.alerts.runtime import unapplied_migrations, wait_for_migrations
from apps.alerts.tests.helpers import make_rule

defaults = importlib.import_module("apps.alerts.migrations.0002_default_rules")

DEFAULT_KEYS = {"server-offline", "target-failing", "device-unreachable", "container-failed"}


def install_again():
    """Run the default-rule installation again, as re-applying the migration would."""
    defaults.install(django_apps, SimpleNamespace(connection=connection))


class DefaultRuleTests(TestCase):
    def test_the_basic_failures_are_watched_from_the_start(self):
        rules = {rule.key: rule for rule in AlertRule.objects.exclude(key=None)}
        self.assertEqual(set(rules), DEFAULT_KEYS)
        expected = {
            "server-offline": ("Server offline", "server", "offline"),
            "target-failing": ("Network target failing", "target", "failing"),
            "device-unreachable": ("SNMP device unreachable", "device", "unreachable"),
            "container-failed": ("Docker container unhealthy or dead", "container", ""),
        }
        for key, (name, kind, reason) in expected.items():
            rule = rules[key]
            with self.subTest(key=key):
                self.assertEqual((rule.name, rule.entity_kind, rule.reason), (name, kind, reason))
                self.assertEqual((rule.condition, rule.health, rule.severity, rule.enabled), ("health", "critical", "critical", True))
                # SNMP polls are five minutes apart by default: three in a row, not one.
                activation = 600 if key == "device-unreachable" else 60
                self.assertEqual((rule.activation_seconds, rule.recovery_seconds), (activation, 120))
                self.assertIsNone(rule.customer_id)
                self.assertIsNone(rule.site_id)
                rule.full_clean()  # what the admin would accept

    def test_no_warning_or_unknown_status_opens_an_incident_by_default(self):
        self.assertEqual(set(AlertRule.objects.values_list("health", flat=True)), {"critical"})

    def test_installing_again_adds_nothing_and_undoes_nothing(self):
        server = AlertRule.objects.get(key="server-offline")
        server.enabled = False
        server.activation_seconds = 300
        server.save()
        AlertRule.objects.get(key="device-unreachable").delete()
        make_rule("SNMP DEVICE unreachable", entity_kind="device", reason="unreachable")  # the name is taken
        install_again()
        install_again()
        server.refresh_from_db()
        self.assertEqual((server.enabled, server.activation_seconds), (False, 300))
        self.assertEqual(set(AlertRule.objects.exclude(key=None).values_list("key", flat=True)), DEFAULT_KEYS - {"device-unreachable"})
        self.assertEqual(AlertRule.objects.count(), 4)

    def test_a_missing_default_is_added_when_the_migration_is_applied_again(self):
        AlertRule.objects.get(key="container-failed").delete()
        install_again()
        self.assertTrue(AlertRule.objects.filter(key="container-failed", enabled=True).exists())


class MigrationTests(TransactionTestCase):
    def migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(targets)

    def tearDown(self):
        # Leave every migration applied, as the other tests expect.
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def tables(self):
        with connection.cursor() as cursor:
            return {name for name in connection.introspection.table_names(cursor) if name.startswith("alerts_")}

    def test_the_app_installs_and_uninstalls_cleanly(self):
        self.assertEqual(
            self.tables(),
            {
                "alerts_alertrule",
                "alerts_incident",
                "alerts_incidentevent",
                "alerts_alertevaluationstate",
                "alerts_alertengineheartbeat",
                "alerts_notificationsubscription",
                "alerts_notification",
            },
        )
        self.migrate([("alerts", "0002_default_rules")])
        self.assertNotIn("alerts_notification", self.tables())  # email comes and goes on its own
        self.migrate([("alerts", None)])
        self.assertEqual(self.tables(), set())
        self.migrate([("alerts", "0003_notifications")])
        self.assertEqual(set(AlertRule.objects.values_list("key", flat=True)), DEFAULT_KEYS)

    @override_settings(SENTINEL_SMTP_HOST="smtp.example.com", SENTINEL_EMAIL_FROM="sentinel@example.com")
    def test_the_workers_see_a_pending_migration_and_wait_for_it_never_applying_it(self):
        self.migrate([("alerts", "0002_default_rules")])
        self.assertIn(("alerts", "0003_notifications"), [(m.app_label, m.name) for m, _ in unapplied_migrations()])
        for command in ("run_alert_engine", "run_notifier"):
            with self.subTest(command=command), self.assertRaisesRegex(CommandError, "never migrates"):
                call_command(command, "--once")
        self.assertNotIn("alerts_notification", self.tables())
        log = logging.getLogger("apps.alerts.engine")
        # Serving, they wait; a stop ends the wait.
        stop = threading.Event()
        stop.set()
        with self.assertLogs(log, "WARNING") as logs:
            self.assertFalse(wait_for_migrations(stop, logger=log, liveness=None, within=60, poll=0))
        self.assertIn("1 migration(s) not applied yet: waiting for the web or migrate service", logs.output[0])
        self.assertNotIn("alerts_notification", self.tables())

        # They start once another process (web) has applied it.
        def web_applies_it(seconds):
            self.migrate([("alerts", "0003_notifications")])
            return False

        stop = threading.Event()
        with patch.object(stop, "wait", side_effect=web_applies_it), self.assertLogs(log, "INFO") as logs:
            self.assertTrue(wait_for_migrations(stop, logger=log, liveness=None, within=60, poll=0))
        self.assertIn("the migrations are applied: starting", logs.output[-1])

    def test_the_migrations_are_schema_and_data_only(self):
        """No raw SQL: no trigger or function (the separate database logins refuse objects that run code)."""
        executor = MigrationExecutor(connection)
        allowed = (migrations.CreateModel, migrations.AddConstraint, migrations.AddIndex, migrations.AddField, migrations.RunPython)
        for name in ("0001_initial_alerts", "0002_default_rules", "0003_notifications"):
            for operation in executor.loader.get_migration("alerts", name).operations:
                with self.subTest(migration=name, operation=type(operation).__name__):
                    self.assertIsInstance(operation, allowed)
