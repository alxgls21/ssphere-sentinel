"""The system status in the console API, and the capabilities the session announces."""

from datetime import timedelta

from django.contrib.auth.models import Permission
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from apps.alerts.models import AlertEngineHeartbeat, Notification, NotifierHeartbeat, TestEmailRequest
from apps.alerts.tests.helpers import make_rule, open_incident
from apps.console.tests.helpers import API, make_user, signed_in_client
from apps.inventory.models import Customer

STATUS = API + "system/status/"
SESSION = API + "session/"
SMTP_PASSWORD = "Smtp-Secret-90c2e7aa"
SMTP_ON = override_settings(
    SENTINEL_SMTP_HOST="smtp.example.com",
    SENTINEL_SMTP_PORT=465,
    SENTINEL_SMTP_SECURITY="tls",
    SENTINEL_EMAIL_FROM="Sentinel <sentinel@example.com>",
    SENTINEL_SMTP_USER="smtp-login-name",
    SENTINEL_SMTP_PASSWORD=SMTP_PASSWORD,
    SENTINEL_CONSOLE_URL="https://sentinel.example.com",
)
SMTP_OFF = override_settings(SENTINEL_SMTP_HOST="", SENTINEL_SMTP_USER="", SENTINEL_SMTP_PASSWORD="")


def grant(user, *codenames: str):
    for codename in codenames:
        app, _, name = codename.partition(".")
        user.user_permissions.add(Permission.objects.get(content_type__app_label=app, codename=name))
    return type(user).objects.get(pk=user.pk)


@SMTP_ON
class SystemStatusTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.operator = grant(make_user("operator", all_customers=True), "console.view_system_status")

    def status(self, user=None):
        response = signed_in_client(user or self.operator).get(STATUS)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def beat(self, **fields):
        NotifierHeartbeat.objects.update_or_create(pk=1, defaults={"started_at": self.now - timedelta(hours=1), **fields})

    def test_it_needs_the_permission_and_every_customer(self):
        acme = Customer.objects.create(name="Acme")
        restricted = grant(make_user("restricted", customers=[acme]), "console.view_system_status")
        everyone = make_user("everyone", all_customers=True)
        for user, status in ((restricted, 403), (everyone, 403), (make_user("root", superuser=True), 200), (self.operator, 200)):
            with self.subTest(user=user.username):
                self.assertEqual(signed_in_client(user).get(STATUS).status_code, status)
        self.assertEqual(Client().get(STATUS).status_code, 401)
        self.assertEqual(signed_in_client(self.operator).get(STATUS, {"x": "1"}).status_code, 400)
        self.assertEqual(signed_in_client(self.operator).post(STATUS).status_code, 405)

    def test_the_notifier_states(self):
        self.assertEqual(self.status()["notifier"]["state"], "never_started")
        self.assertIsNone(self.status()["notifier"]["authenticationConfigured"])
        self.beat(beat_at=self.now - timedelta(seconds=20), interval_seconds=15, last_cycle_ms=40,
                  server_configured=True, authentication_configured=True)
        notifier = self.status()["notifier"]
        self.assertEqual(
            (notifier["state"], notifier["stale"], notifier["staleAfterSeconds"], notifier["intervalSeconds"]),
            ("running", False, 630, 15),
        )
        self.assertEqual((notifier["smtpConfigured"], notifier["authenticationConfigured"], notifier["lastError"]), (True, True, None))
        self.beat(last_error_at=self.now - timedelta(seconds=5), last_error_category="database")
        notifier = self.status()["notifier"]
        self.assertEqual((notifier["state"], notifier["lastError"]["category"]), ("failed", "database"))
        self.beat(beat_at=self.now - timedelta(hours=1), last_error_at=None, last_error_category="")
        self.assertEqual(self.status()["notifier"]["state"], "stale")
        with override_settings(SENTINEL_SMTP_HOST=""):
            self.assertEqual(self.status()["notifier"]["state"], "disabled")

    def test_a_long_cycle_is_alive_and_an_smtp_failure_is_a_failure(self):
        # The last cycle ended half an hour ago, and the notifier has been sending since: alive.
        self.beat(beat_at=self.now - timedelta(minutes=30), active_at=self.now - timedelta(seconds=20), interval_seconds=15)
        notifier = self.status()["notifier"]
        self.assertEqual((notifier["state"], notifier["stale"]), ("running", False))
        self.assertEqual(notifier["lastActiveAt"][:19], (self.now - timedelta(seconds=20)).isoformat()[:19])
        self.beat(server_error_at=self.now - timedelta(seconds=5), server_error_category="authentication", active_at=self.now)
        notifier = self.status()["notifier"]
        self.assertEqual((notifier["state"], notifier["lastSmtpError"]["category"], notifier["lastError"]), ("failed", "authentication", None))

    def test_an_smtp_failure_stays_the_state_until_the_server_is_reached_again(self):
        # Failed at the last retry; the cycles since completed and found nothing to send.
        self.beat(beat_at=self.now - timedelta(seconds=10), active_at=self.now - timedelta(seconds=10),
                  server_error_at=self.now - timedelta(minutes=1), server_error_category="authentication",
                  server_reached_at=self.now - timedelta(hours=2), interval_seconds=15)
        self.assertEqual(self.status()["notifier"]["state"], "failed")
        # A failure of the notifier itself, and a cycle completed since: the SMTP server still fails.
        self.beat(last_error_at=self.now - timedelta(seconds=30), last_error_category="database")
        notifier = self.status()["notifier"]
        self.assertEqual((notifier["state"], notifier["lastError"]["category"]), ("failed", "database"))
        self.beat(server_reached_at=self.now - timedelta(seconds=10))
        notifier = self.status()["notifier"]
        self.assertEqual((notifier["state"], notifier["lastSmtpError"]["category"]), ("running", "authentication"))
        self.assertEqual(notifier["lastSmtpSuccessAt"][:19], (self.now - timedelta(seconds=10)).isoformat()[:19])
        # A database failure lasts until a cycle completes.
        self.beat(last_error_at=self.now - timedelta(seconds=5))
        self.assertEqual(self.status()["notifier"]["state"], "failed")

    def test_active_without_an_ended_cycle_is_not_running(self):
        self.beat(active_at=self.now, interval_seconds=15)
        self.assertEqual(self.status()["notifier"]["state"], "never_started")
        # Alive between emails, yet no cycle ended for longer than any can take: stuck.
        self.beat(beat_at=self.now - timedelta(hours=2), active_at=self.now)
        self.assertEqual(self.status()["notifier"]["state"], "stale")

    def test_a_test_email_past_its_time_is_not_open(self):
        user = make_user("ops", email="ops@example.com", all_customers=True)
        past = self.now - timedelta(minutes=30)
        TestEmailRequest.objects.create(requested_by=user, requested_by_name="ops", created_at=past, expires_at=past + timedelta(minutes=10))
        self.assertEqual(self.status()["outbox"]["testEmails"]["open"], 0)

    def test_the_alert_engine_as_its_own_endpoint_says(self):
        AlertEngineHeartbeat.objects.create(started_at=self.now, beat_at=self.now, interval_seconds=30)
        engine = self.status()["alertEngine"]
        own = signed_in_client(self.operator).get(API + "alerts/engine-status/").json()
        own.pop("generatedAt")
        self.assertEqual(engine, own)
        self.assertEqual(engine["state"], "running")

    def test_the_outbox_in_counts(self):
        user = make_user("ops", email="ops@example.com", all_customers=True)
        rule = make_rule(reason="offline")

        def email(status, *, age=timedelta(minutes=1), failure="", **fields):
            created = self.now - age
            if status == "sent":
                fields["sent_at"] = created
            if status == "sending":
                fields.update(claim="00000000-0000-0000-0000-000000000001", lease_expires_at=self.now + timedelta(minutes=5))
            Notification.objects.create(
                incident=open_incident(rule), recipient=user, recipient_name="ops", kind="opened", status=status,
                created_at=created, next_attempt_at=created, failure=failure, **fields,
            )

        email("pending", age=timedelta(minutes=5))
        email("pending", age=timedelta(hours=30))  # overdue, and not in the last day
        email("sending")
        email("sent")
        email("failed", failure="authentication")
        email("cancelled", failure="not_visible")
        TestEmailRequest.objects.create(
            requested_by=user, requested_by_name="ops", created_at=self.now, expires_at=self.now + timedelta(minutes=10)
        )
        outbox = self.status()["outbox"]
        self.assertEqual((outbox["pending"], outbox["sending"], outbox["overdue"]), (2, 1, 1))
        self.assertEqual(outbox["oldestPendingAt"][:16], (self.now - timedelta(hours=30)).isoformat()[:16])
        self.assertEqual(outbox["last24Hours"], {
            "created": 5, "sent": 1, "failed": 1, "cancelled": 1,
            "failures": {"authentication": 1, "not_visible": 1},
        })
        self.assertEqual(outbox["testEmails"]["open"], 1)
        self.assertEqual(outbox["testEmails"]["last24Hours"]["pending"], 1)

    def test_the_environment_as_the_deployment_sets_it_never_a_secret(self):
        body = self.status()
        self.assertEqual(body["environment"]["email"], {
            "enabled": True, "host": "smtp.example.com", "port": 465, "security": "tls",
            "fromAddress": "Sentinel <sentinel@example.com>", "timeoutSeconds": 10, "maxAgeHours": 24,
            "consoleUrl": "https://sentinel.example.com",
        })
        self.assertEqual(set(body["environment"]["retention"]), {
            "incidentDays", "notificationDays", "networkMeasurementDays", "snmpDays", "telemetryDays", "absentContainerDays",
        })
        self.assertIn("thresholds", body["environment"]["monitoring"])
        self.beat(beat_at=self.now, interval_seconds=15, server_configured=True, authentication_configured=True)
        text = signed_in_client(self.operator).get(STATUS).content.decode()
        for secret in (SMTP_PASSWORD, "smtp-login-name", "password", "DJANGO_SECRET_KEY"):
            self.assertNotIn(secret, text)

    @SMTP_OFF
    def test_with_email_off(self):
        body = self.status()
        self.assertEqual((body["environment"]["email"]["enabled"], body["environment"]["email"]["host"]), (False, None))
        self.assertEqual(body["notifier"]["state"], "disabled")


class CapabilityTests(TestCase):
    def capabilities(self, user):
        return signed_in_client(user).get(SESSION).json()["capabilities"]

    def test_each_capability_follows_its_permission_and_rules_need_every_customer(self):
        acme = Customer.objects.create(name="Acme")
        everything = (
            "alerts.view_alertrule", "alerts.add_alertrule", "alerts.change_alertrule", "alerts.send_test_email",
            "console.view_system_status", "alerts.acknowledge_incident",
        )
        global_user = grant(make_user("global", all_customers=True), *everything)
        self.assertEqual(self.capabilities(global_user), {
            "acknowledgeIncidents": True, "viewAlertRules": True, "createAlertRules": True, "editAlertRules": True,
            "manageOwnNotifications": True, "sendTestEmail": True, "viewSystemStatus": True,
        })
        restricted = grant(make_user("restricted", customers=[acme]), *everything)
        self.assertEqual(self.capabilities(restricted), {
            "acknowledgeIncidents": True, "viewAlertRules": False, "createAlertRules": False, "editAlertRules": False,
            "manageOwnNotifications": True, "sendTestEmail": True, "viewSystemStatus": False,
        })
        plain = make_user("plain", all_customers=True)
        self.assertEqual({name for name, value in self.capabilities(plain).items() if value}, {"manageOwnNotifications"})
        editor = grant(make_user("editor", all_customers=True), "alerts.change_alertrule")
        self.assertEqual(
            {name for name, value in self.capabilities(editor).items() if value},
            {"viewAlertRules", "editAlertRules", "manageOwnNotifications"},
        )
        self.assertIsNone(Client().get(SESSION).json()["capabilities"])

    def test_no_group_is_made_for_the_new_permissions(self):
        from django.contrib.auth.models import Group

        for codename in ("send_test_email", "view_system_status", "add_alertrule", "change_alertrule"):
            with self.subTest(codename=codename):
                self.assertFalse(Group.objects.filter(permissions__codename=codename).exists())
