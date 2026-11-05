"""The admin login form shares the console's sign-in throttle (one lockout per account for both)."""

from datetime import timedelta
from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth import authenticate as real_authenticate
from django.contrib.auth.hashers import make_password
from django.test import Client
from django.utils import timezone

from apps.console.models import LoginThrottle
from apps.console.tests.helpers import PASSWORD, make_user
from apps.console.tests.test_session_api import SESSION, ConsoleTestCase

ADMIN_LOGIN = "/admin/login/?next=/admin/"  # as the admin's own form posts it


class AdminLoginThrottleTests(ConsoleTestCase):
    def setUp(self):
        self.admin = make_user("admin", superuser=True, is_staff=True)
        self.client_ = Client()

    def admin_attempt(self, username="admin", password="wrong-password", client=None):
        return (client or self.client_).post(ADMIN_LOGIN, {"username": username, "password": password})

    def errors(self, response):
        self.assertEqual(response.status_code, 200)  # the form again, not a redirect into the admin
        return list(response.context["form"].non_field_errors())

    def signed_in_to_admin(self, client):
        return client.get("/admin/").status_code == 200

    def row(self, user):
        return LoginThrottle.objects.filter(key=f"u:{user.pk}").first()

    def test_the_admin_site_uses_the_throttled_form(self):
        from apps.console.admin_login import ThrottledAdminAuthenticationForm

        self.assertIs(admin.site.login_form, ThrottledAdminAuthenticationForm)

    def test_after_five_wrong_passwords_even_the_right_one_is_refused_with_the_same_answer(self):
        failures = [self.errors(self.admin_attempt()) for _ in range(5)]
        locked = self.admin_attempt(password=PASSWORD)
        self.assertEqual(self.errors(locked), failures[0])
        self.assertEqual(len({tuple(f) for f in failures}), 1)
        self.assertFalse(self.signed_in_to_admin(self.client_))
        self.assertIsNotNone(self.row(self.admin).locked_until)
        self.assertEqual(self.row(self.admin).user, self.admin)  # shown under Login throttles

    def test_the_attempt_is_counted_before_the_password_is_checked(self):
        seen = {}

        def spy(request, username, password):
            seen["attempts"] = self.row(self.admin).attempts
            return real_authenticate(request, username=username, password=password)

        with patch("django.contrib.auth.forms.authenticate", side_effect=spy):
            response = self.admin_attempt(password=PASSWORD)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(seen["attempts"], 1)

    def test_a_locked_account_is_never_compared_with_its_stored_hash(self):
        for _ in range(6):
            self.admin_attempt()
        with (
            patch("django.contrib.auth.forms.authenticate", wraps=real_authenticate) as authenticate,
            patch("apps.console.admin_login.make_password", wraps=make_password) as hashing,
        ):
            self.admin_attempt(password=PASSWORD)
        self.assertEqual(authenticate.call_count, 0)
        self.assertEqual(hashing.call_count, 1)  # the same hashing work as for an unknown name

    def test_unknown_names_and_accounts_without_staff_access_get_the_same_answer(self):
        make_user("viewer")  # a console user, not staff
        wrong = self.errors(self.admin_attempt())
        unknown = self.errors(self.admin_attempt("ghost"))
        with patch("django.contrib.auth.forms.authenticate", wraps=real_authenticate) as authenticate:
            not_staff = self.errors(self.admin_attempt("viewer", PASSWORD))  # the RIGHT password
        self.assertEqual(wrong, unknown)
        self.assertEqual(wrong, not_staff)
        self.assertEqual(authenticate.call_count, 0)  # never compared: it could never sign in here
        self.assertTrue(LoginThrottle.objects.filter(key__startswith="x:").exists())  # unknown names are counted

    def test_a_successful_admin_login_clears_the_failures(self):
        for _ in range(4):
            self.admin_attempt()
        response = self.admin_attempt(password=PASSWORD)
        self.assertRedirects(response, "/admin/", fetch_redirect_response=False)
        self.assertIsNone(self.row(self.admin))
        for _ in range(5):  # a full new allowance
            self.admin_attempt(client=Client())
        self.assertIsNone(self.row(self.admin).locked_until)

    def test_a_successful_console_sign_in_clears_the_admin_failures(self):
        for _ in range(4):
            self.admin_attempt()
        client, token = self.csrf_client()
        self.assertEqual(self.sign_in(client, token, "admin", PASSWORD).status_code, 200)
        self.assertIsNone(self.row(self.admin))

    def test_a_successful_admin_login_clears_the_console_failures(self):
        client, token = self.csrf_client()
        for _ in range(4):
            self.sign_in(client, token, "admin", "wrong-password")
        self.assertEqual(self.row(self.admin).attempts, 4)
        self.assertEqual(self.admin_attempt(password=PASSWORD).status_code, 302)
        self.assertIsNone(self.row(self.admin))

    def test_an_account_locked_at_the_admin_cannot_sign_in_to_the_console(self):
        for _ in range(6):
            self.admin_attempt()
        client, token = self.csrf_client()
        response = self.sign_in(client, token, "admin", PASSWORD)
        self.assertEqual(response.status_code, 401)
        self.assertFalse(client.get(SESSION).json()["authenticated"])

    def test_an_account_locked_at_the_console_cannot_log_in_to_the_admin(self):
        client, token = self.csrf_client()
        for _ in range(6):
            self.sign_in(client, token, "admin", "wrong-password")
        self.errors(self.admin_attempt(password=PASSWORD))
        self.assertFalse(self.signed_in_to_admin(self.client_))

    def test_other_accounts_are_unaffected(self):
        other = make_user("other-admin", superuser=True, is_staff=True)
        for _ in range(6):
            self.admin_attempt()
        client = Client()
        self.assertEqual(self.admin_attempt("other-admin", PASSWORD, client=client).status_code, 302)
        self.assertTrue(self.signed_in_to_admin(client))
        self.assertIsNone(self.row(other))

    def test_the_lock_ends_after_the_lockout(self):
        for _ in range(6):
            self.admin_attempt()
        LoginThrottle.objects.update(locked_until=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.admin_attempt(password=PASSWORD).status_code, 302)

    def test_an_incomplete_form_is_not_counted(self):
        response = self.client_.post(ADMIN_LOGIN, {"username": "admin", "password": ""})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(LoginThrottle.objects.exists())
