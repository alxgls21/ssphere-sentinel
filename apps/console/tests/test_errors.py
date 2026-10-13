"""Everything under /api/v1/console/ answers JSON, errors included."""

import logging
from unittest.mock import patch

from django.core.exceptions import BadRequest, PermissionDenied, SuspiciousOperation
from django.http import Http404

from django.test import Client, TestCase

from apps.console.access import NotVisible
from apps.console.tests.helpers import make_user, signed_in_client


class JsonErrorTests(TestCase):
    def test_unknown_urls_are_json_404_for_everyone(self):
        for client in (Client(), signed_in_client(make_user("viewer"))):
            for url in ("/api/v1/console/nope/", "/api/v1/console/", "/api/v1/console/scope/extra/", "/api/v1/console/%2e%2e/admin/"):
                response = client.get(url)
                self.assertEqual(response.status_code, 404, url)
                self.assertEqual(response["Content-Type"], "application/json")
                self.assertEqual(response.json()["error"]["code"], "not_found")
                self.assertIn("no-store", response["Cache-Control"])

    def test_an_unexpected_exception_is_a_json_500_without_details(self):
        client = signed_in_client(make_user("ops", all_customers=True))
        with patch("apps.console.views.scope_payload", side_effect=RuntimeError("secret-internal-detail /etc/passwd")):
            with self.assertLogs("apps.console", level="ERROR") as logs:
                response = client.get("/api/v1/console/scope/")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json()["error"]["code"], "internal_error")
        self.assertNotIn("secret-internal-detail", response.content.decode())
        self.assertIn("secret-internal-detail", "\n".join(logs.output))  # but the operator's log has it

    def test_csrf_failures_are_json_under_the_console_and_untouched_elsewhere(self):
        client = Client(enforce_csrf_checks=True)
        console = client.post("/api/v1/console/auth/logout/")
        self.assertEqual((console.status_code, console.json()["error"]["code"]), (403, "csrf_failed"))
        admin = client.post("/admin/login/", {"username": "x", "password": "y"})
        self.assertEqual(admin.status_code, 403)
        self.assertIn("text/html", admin["Content-Type"])

    def test_health_endpoints_and_admin_are_untouched(self):
        self.assertEqual(Client().get("/health/").status_code, 200)
        self.assertEqual(Client().get("/admin/login/").status_code, 200)


class ExceptionMappingTests(TestCase):
    """What a view raises is answered as the matching JSON error, not as a 500."""

    CASES = (
        (NotVisible("leak-NotVisible"), 404, "not_found"),
        (Http404("leak-Http404"), 404, "not_found"),
        (PermissionDenied("leak-PermissionDenied"), 403, "forbidden"),
        (SuspiciousOperation("leak-SuspiciousOperation"), 400, "bad_request"),
        (BadRequest("leak-BadRequest"), 400, "bad_request"),
        (RuntimeError("leak-RuntimeError"), 500, "internal_error"),
    )

    def test_each_exception_has_its_status(self):
        client = signed_in_client(make_user("ops", all_customers=True))
        for exc, status, code in self.CASES:
            with self.subTest(exc=type(exc).__name__):
                with patch("apps.console.views.scope_payload", side_effect=exc):
                    response = client.get("/api/v1/console/scope/")
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code))
                self.assertEqual(response["Content-Type"], "application/json")
                self.assertIn("no-store", response["Cache-Control"])
                self.assertNotIn("leak-", response.content.decode())  # no exception text reaches the client

    def test_what_is_logged_for_each_kind(self):
        client = signed_in_client(make_user("ops", all_customers=True))
        expectations = {
            "NotVisible": None,  # an ordinary 404: nothing to report
            "Http404": None,
            "PermissionDenied": None,
            "SuspiciousOperation": ("WARNING", "SuspiciousOperation"),
            "BadRequest": ("WARNING", "BadRequest"),
            "RuntimeError": ("ERROR", "leak-RuntimeError"),  # an unexpected failure: traceback for the operator
        }
        for exc, _status, _code in self.CASES:
            name = type(exc).__name__
            with self.subTest(exc=name), patch("apps.console.views.scope_payload", side_effect=exc):
                expected = expectations[name]
                if expected is None:
                    with self.assertNoLogs("apps.console", level="WARNING"):
                        client.get("/api/v1/console/scope/")
                else:
                    with self.assertLogs("apps.console", level="WARNING") as logs:
                        client.get("/api/v1/console/scope/")
                    level, text = expected
                    self.assertEqual(logs.records[0].levelname, level)
                    self.assertIn(text, logs.output[0] + (logs.records[0].exc_text or ""))

    def test_not_visible_is_never_a_server_error_or_a_logged_traceback(self):
        client = signed_in_client(make_user("ops", all_customers=True))
        with patch("apps.console.views.scope_payload", side_effect=NotVisible()):
            with self.assertNoLogs("apps.console", level="ERROR"):
                response = client.get("/api/v1/console/scope/")
        self.assertEqual(response.status_code, 404)

    def test_the_csrf_view_uses_the_routed_path(self):
        # path_info, not path: a script prefix must not decide between JSON and HTML.
        client = Client(enforce_csrf_checks=True)
        response = client.post("/api/v1/console/auth/login/", data="{}", content_type="application/json", SCRIPT_NAME="/sentinel")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response["Content-Type"], "application/json")

    def test_the_prefix_constant_matches_the_routing(self):
        from django.urls import reverse

        from apps.console.http import API_PREFIX

        for name in ("console-session", "console-login", "console-logout", "console-scope"):
            self.assertTrue(reverse(name).startswith(API_PREFIX), name)
