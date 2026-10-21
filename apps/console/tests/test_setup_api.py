"""First-run setup: the first administrator, created from the console with the setup code (apps.console.setup)."""

import io
import json
import re

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import Client, TestCase, override_settings

from apps.console import setup
from apps.console.models import LoginThrottle, SetupCode

SESSION = "/api/v1/console/session/"
SETUP = "/api/v1/console/setup/"
GOOD_PASSWORD = "a-long-and-unusual-passphrase-41"


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS=5,
    SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS=900,
    SENTINEL_CONSOLE_SESSION_SECONDS=43200,
    SECURE_SSL_REDIRECT=False,
)
class SetupTests(TestCase):
    def setUp(self):
        self.code = setup.prepare()
        self.client = Client(enforce_csrf_checks=True, raise_request_exception=False)
        self.token = self.client.get(SESSION).json()["csrfToken"]

    def post(self, body, token=None, **extra):
        payload = body if isinstance(body, str) else json.dumps(body)
        return self.client.post(SETUP, data=payload, content_type="application/json",
                                HTTP_X_CSRFTOKEN=self.token if token is None else token, **extra)

    def create(self, code=None, **fields):
        return self.post({"code": self.code if code is None else code, "username": "admin",
                          "email": "admin@example.com", "password": GOOD_PASSWORD, **fields})

    def test_it_is_required_while_there_is_no_user(self):
        self.assertEqual(self.client.get(SETUP).json(), {"required": True})
        get_user_model().objects.create_user("someone", password=GOOD_PASSWORD)
        self.assertEqual(self.client.get(SETUP).json(), {"required": False})

    def test_the_code_creates_the_first_administrator_and_signs_them_in(self):
        response = self.create()
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertTrue(body["authenticated"])
        user = get_user_model().objects.get()
        self.assertEqual((user.username, user.email, user.is_superuser, user.is_staff),
                         ("admin", "admin@example.com", True, True))
        self.assertTrue(user.check_password(GOOD_PASSWORD))
        self.assertFalse(SetupCode.objects.exists())
        self.assertTrue(self.client.get(SESSION).json()["authenticated"])
        # It is over: the same code, or any other, finds nothing.
        self.assertEqual(self.client.get(SETUP).json(), {"required": False})
        again = self.post({"code": self.code, "username": "second", "password": GOOD_PASSWORD},
                          token=body["csrfToken"])
        self.assertEqual((again.status_code, again.json()["error"]["code"]), (404, "not_found"))
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_the_code_is_typed_as_people_type_it(self):
        response = self.create(code=f"  {self.code.lower().replace('-', ' ')} ")
        self.assertEqual(response.status_code, 200, response.content)

    def test_a_wrong_code_is_refused_and_counted(self):
        for _ in range(5):
            response = self.create(code="AAAA-BBBB-CCCC")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "invalid_code"))
        response = self.create()  # the right one, too late
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (429, "too_many_attempts"))
        self.assertFalse(get_user_model().objects.exists())
        self.assertTrue(SetupCode.objects.exists())

    def test_the_right_code_with_a_weak_password_can_be_tried_again(self):
        for _ in range(7):
            response = self.create(password="password")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "validation_error"))
            self.assertIn("password", response.json()["error"]["fields"])
        self.assertFalse(LoginThrottle.objects.exists())
        self.assertEqual(self.create().status_code, 200)

    def test_the_account_is_validated(self):
        response = self.create(username="bad name!", email="not-an-email")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(response.json()["error"]["fields"]), {"username", "email"})
        self.assertEqual(self.create(email=None).status_code, 200)  # no email: allowed

    def test_malformed_requests_are_refused(self):
        for body in ("{broken", [], {"code": self.code}, {"code": 1, "username": "a", "password": GOOD_PASSWORD},
                     {"code": self.code, "username": "a\x00", "password": GOOD_PASSWORD},
                     {"code": self.code, "username": "a", "password": "x" * 2000}):
            with self.subTest(body=body):
                self.assertEqual(self.post(body).status_code, 400)
        self.assertFalse(get_user_model().objects.exists())

    def test_it_needs_the_csrf_token(self):
        response = Client(enforce_csrf_checks=True).post(
            SETUP, data=json.dumps({"code": self.code, "username": "admin", "password": GOOD_PASSWORD}),
            content_type="application/json")
        self.assertEqual(response.status_code, 403)
        self.assertFalse(get_user_model().objects.exists())

    def test_without_a_code_there_is_nothing_to_set_up(self):
        SetupCode.objects.all().delete()
        response = self.create()
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "not_found"))

    def test_once_a_user_exists_it_is_over(self):
        get_user_model().objects.create_user("someone", password=GOOD_PASSWORD)
        self.assertEqual(self.create().status_code, 404)
        self.assertEqual(get_user_model().objects.count(), 1)


class SetupCodeTests(TestCase):
    def test_a_new_code_replaces_the_last_and_only_its_hash_is_kept(self):
        first, second = setup.prepare(), setup.prepare()
        self.assertNotEqual(first, second)
        for code in (first, second):
            self.assertRegex(code, r"^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$")
        (stored,) = SetupCode.objects.all()
        self.assertEqual(stored.code_hash, setup.code_hash(second))
        self.assertNotIn(second.replace("-", ""), stored.code_hash.upper())

    def test_once_a_user_exists_there_is_none(self):
        setup.prepare()
        get_user_model().objects.create_user("someone", password=GOOD_PASSWORD)
        self.assertIsNone(setup.prepare())
        self.assertFalse(SetupCode.objects.exists())

    def test_the_command_prints_it_for_the_log(self):
        out = io.StringIO()
        call_command("setup_code", stdout=out)
        (code,) = re.findall(r"^setup:     (\S+)$", out.getvalue(), re.MULTILINE)
        self.assertEqual(SetupCode.objects.get().code_hash, setup.code_hash(code))
        get_user_model().objects.create_user("someone", password=GOOD_PASSWORD)
        out = io.StringIO()
        call_command("setup_code", stdout=out)
        self.assertEqual(out.getvalue(), "")
        self.assertFalse(SetupCode.objects.exists())
