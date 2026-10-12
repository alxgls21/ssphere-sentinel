from unittest.mock import patch

from django.conf import settings
from django.db import OperationalError
from django.test import TestCase, override_settings

LIVENESS = "/health/"
READINESS = "/health/ready/"


class HealthEndpointTests(TestCase):
    def test_liveness_needs_no_database(self):
        with self.assertNumQueries(0):
            response = self.client.get(LIVENESS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_readiness_checks_the_database(self):
        response = self.client.get(READINESS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "database": "ok"})
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_readiness_reports_unavailable_without_details(self):
        detail = 'connection to server at "db" (10.0.0.5), port 5432 failed'
        with patch(
            "apps.core.views.connection.cursor", side_effect=OperationalError(detail)
        ), self.assertLogs("apps.core.views", level="WARNING") as logs:
            response = self.client.get(READINESS)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable", "database": "unavailable"})
        self.assertNotIn("10.0.0.5", response.content.decode())
        # The reason is only in the server log.
        self.assertIn("10.0.0.5", logs.output[0])

    def test_head_is_allowed_and_post_is_not(self):
        for path in (LIVENESS, READINESS):
            with self.subTest(path=path):
                self.assertEqual(self.client.head(path).status_code, 200)
                self.assertEqual(self.client.post(path).status_code, 405)

    def test_probes_by_ip_bypass_allowed_hosts(self):
        # Container healthchecks connect to 127.0.0.1 or the container IP,
        # which production ALLOWED_HOSTS does not list.
        for path in (LIVENESS, READINESS):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, HTTP_HOST="172.18.0.5:8000").status_code, 200)
        # Everything else still validates the Host header, logged as a single
        # warning line rather than an ERROR with a traceback.
        with self.assertLogs("django.security.DisallowedHost", level="WARNING") as logs:
            response = self.client.get("/admin/login/", HTTP_HOST="172.18.0.5:8000")
        self.assertEqual(response.status_code, 400)
        record = logs.records[0]
        self.assertEqual(record.levelname, "WARNING")
        self.assertIsNone(record.exc_info)
        self.assertIn("172.18.0.5", record.getMessage())

    @override_settings(SECURE_SSL_REDIRECT=True)
    def test_probes_are_not_redirected_to_https(self):
        self.assertEqual(self.client.get(LIVENESS).status_code, 200)
        self.assertEqual(self.client.get(READINESS).status_code, 200)
        self.assertEqual(self.client.get("/admin/login/").status_code, 301)

    def test_health_middleware_runs_first(self):
        self.assertEqual(settings.MIDDLEWARE[0], "apps.core.middleware.HealthCheckMiddleware")
