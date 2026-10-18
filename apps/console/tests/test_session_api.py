"""Console session, sign-in and sign-out."""

import json
import re
import time
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import authenticate as real_authenticate
from django.contrib.auth.hashers import PBKDF2PasswordHasher, make_password
from django.contrib.sessions.models import Session
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from apps.console.http import CONSOLE_SESSION_KEY
from apps.console.models import LoginThrottle
from apps.console.tests.helpers import PASSWORD, load_contract, make_user, signed_in_client, start_console_session

SESSION = "/api/v1/console/session/"
LOGIN = "/api/v1/console/auth/login/"
LOGOUT = "/api/v1/console/auth/logout/"
SCOPE = "/api/v1/console/scope/"


def matches(actual, expected, path="$"):
    """Compare a response with a contract fixture; ``<iso-utc>`` and ``<token>`` are placeholders."""

    def check(condition, *details):
        if not condition:  # not ``assert``: it must also hold under ``python -O``
            raise AssertionError((path, *details))

    if expected == "<iso-utc>":
        check(isinstance(actual, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", actual), actual)
    elif expected == "<token>":
        check(isinstance(actual, str) and len(actual) >= 32, actual)
    elif isinstance(expected, dict):
        check(isinstance(actual, dict) and set(actual) == set(expected), sorted(actual), sorted(expected))
        for key in expected:
            matches(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        check(isinstance(actual, list) and len(actual) == len(expected), actual)
        for index, (a, e) in enumerate(zip(actual, expected)):
            matches(a, e, f"{path}[{index}]")
    else:
        check(actual == expected, actual, expected)


# Pinned, so the tests do not depend on SENTINEL_* values in the environment they run in.
@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],  # these tests sign in hundreds of times
    SENTINEL_CONSOLE_SESSION_SECONDS=43200,
    SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS=5,
    SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS=900,
    SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT=80,
    SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT=95,
    SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT=2,
    SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS=150,
    SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES=3,
    SECURE_SSL_REDIRECT=False,  # an environment that enables the redirect would answer 301 to every request
)
class ConsoleTestCase(TestCase):
    def csrf_client(self):
        """A client that enforces CSRF, with the token the UI would send."""
        client = Client(enforce_csrf_checks=True, raise_request_exception=False)
        token = client.get(SESSION).json()["csrfToken"]
        return client, token

    def post(self, client, token, url, body, **extra):
        if not isinstance(body, (str, bytes)):
            body = json.dumps(body)
        return client.post(
            url, data=body, content_type=extra.pop("content_type", "application/json"), HTTP_X_CSRFTOKEN=token, **extra
        )

    def sign_in(self, client, token, username="viewer", password=PASSWORD):
        return self.post(client, token, LOGIN, {"username": username, "password": password})


class SessionEndpointTests(ConsoleTestCase):
    def test_an_anonymous_caller_gets_200_with_a_csrf_token_and_nothing_else(self):
        response = Client().get(SESSION)
        self.assertEqual(response.status_code, 200)
        matches(response.json(), load_contract("session_anonymous.json"))
        self.assertIn("csrftoken", response.cookies)

    def test_the_contract_for_a_signed_in_user(self):
        user = make_user("alice", first_name="Alice", last_name="Example")
        response = signed_in_client(user).get(SESSION)
        self.assertEqual(response.status_code, 200)
        matches(response.json(), load_contract("session_user.json"))

    def test_all_customers_users_are_flagged(self):
        user = make_user("ops", all_customers=True)
        self.assertTrue(signed_in_client(user).get(SESSION).json()["access"]["allCustomers"])

    def test_display_name_falls_back_to_the_username(self):
        self.assertEqual(signed_in_client(make_user("bob")).get(SESSION).json()["user"]["displayName"], "bob")

    def test_a_session_without_console_access_is_reported_and_keeps_its_csrf_token(self):
        client = signed_in_client(make_user("admin-only", console=False))
        body = client.get(SESSION).json()
        self.assertEqual((body["authenticated"], body["reason"]), (False, "no_console_access"))
        self.assertTrue(body["csrfToken"])  # the UI can still sign out or sign in as someone else
        self.assertIsNone(body["user"])
        self.assertEqual(client.get(SCOPE).status_code, 403)

    def test_a_session_that_did_not_come_from_the_console_sign_in_is_not_a_console_session(self):
        # What the Django admin login (or force_login) creates: authenticated, no console marker.
        user = make_user("viewer", all_customers=True)
        client = Client(raise_request_exception=False)
        client.force_login(user)
        self.assertFalse(client.get(SESSION).json()["authenticated"])
        self.assertEqual(client.get(SCOPE).status_code, 401)

    def test_the_console_marker_must_be_an_integer_within_the_lifetime(self):
        user = make_user("viewer", all_customers=True)
        now = 1_800_000_000  # the clock is frozen, so a second rolling over cannot decide a boundary
        for marker, expected in (
            (now, 200),
            (now - 43200, 200),  # the lifetime itself is still inside
            (now - 43200 - 1, 401),  # one second more is not, whatever the cookie says
            (now + 59, 200),  # a clock a little behind is tolerated...
            (now + 60, 200),
            (now + 61, 401),  # ...a marker further in the future is not
            (True, 401),
            ("now", 401),
            (None, 401),
            (float(now), 401),
            (10**400, 401),  # must not overflow a float
            (-(10**400), 401),
        ):
            with self.subTest(marker=marker), patch("apps.console.http.time.time", return_value=float(now)):
                client = Client(raise_request_exception=False)
                client.force_login(user)
                session = client.session
                session[CONSOLE_SESSION_KEY] = marker
                session.save()
                self.assertEqual(client.get(SCOPE).status_code, expected)

    def test_an_inactive_users_session_is_anonymous(self):
        user = make_user("gone")
        client = signed_in_client(user)
        user.is_active = False
        user.save()
        self.assertFalse(client.get(SESSION).json()["authenticated"])
        self.assertEqual(client.get(SCOPE).status_code, 401)

    def test_the_payload_never_contains_secrets(self):
        user = make_user("alice", email="alice@example.com")
        text = signed_in_client(user).get(SESSION).content.decode()
        self.assertNotIn(user.password, text)
        self.assertNotIn("alice@example.com", text)
        # The one word allowed: the capability that names test emails, not an address.
        for word in ("password", "email", "token", "pepper", "secret"):
            self.assertNotIn(word, text.lower().replace("csrftoken", "").replace('"sendtestemail"', ""))

    def test_other_methods_are_405_json_with_allow(self):
        for method in ("post", "put", "patch", "delete"):
            response = getattr(Client(), method)(SESSION)
            self.assertEqual(response.status_code, 405, method)
            self.assertEqual(response.json()["error"]["code"], "method_not_allowed")
            self.assertEqual(response["Allow"], "GET, HEAD")
        self.assertEqual(Client().head(SESSION).status_code, 200)


class HeaderTests(ConsoleTestCase):
    """Every response, success or error, is uncached, varies on the cookie and is JSON."""

    def assert_hardened(self, response, label):
        self.assertIn("no-store", response["Cache-Control"], label)
        self.assertIn("private", response["Cache-Control"], label)
        self.assertIn("Cookie", response["Vary"], label)
        self.assertEqual(response["Content-Type"], "application/json", label)
        self.assertEqual(response["X-Content-Type-Options"], "nosniff", label)

    def test_success_and_every_kind_of_error(self):
        csrf, token = self.csrf_client()
        make_user("viewer")
        make_user("no-console", console=False)
        responses = {
            "session": Client().get(SESSION),
            "401": Client().get(SCOPE),
            "403": signed_in_client(make_user("admin-only", console=False)).get(SCOPE),
            "404": Client().get("/api/v1/console/nope/"),
            "405": Client().post(SESSION),
            "csrf": Client(enforce_csrf_checks=True).post(LOGOUT),
            "bad-request": self.post(csrf, token, LOGIN, "{broken"),
            "bad-media-type": self.post(csrf, token, LOGIN, "x=1", content_type="text/plain"),
            "bad-credentials": self.sign_in(csrf, token, "viewer", "wrong-password"),
            "scope": signed_in_client(make_user("ops", all_customers=True)).get(SCOPE),
        }
        for label, response in responses.items():
            self.assert_hardened(response, label)
        self.assertEqual(
            {label: r.status_code for label, r in responses.items()},
            {
                "session": 200, "401": 401, "403": 403, "404": 404, "405": 405, "csrf": 403,
                "bad-request": 400, "bad-media-type": 415, "bad-credentials": 401, "scope": 200,
            },
        )


class SignInTests(ConsoleTestCase):
    def setUp(self):
        self.user = make_user("viewer")

    def test_sign_in_returns_the_session_and_sets_a_session_cookie(self):
        client, token = self.csrf_client()
        response = self.sign_in(client, token)
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertTrue(body["authenticated"])
        self.assertEqual(body["user"]["username"], "viewer")
        cookie = response.cookies["sessionid"]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Lax")
        self.assertTrue(client.get(SESSION).json()["authenticated"])
        self.assertEqual(client.get(SCOPE).status_code, 200)

    @override_settings(SENTINEL_CONSOLE_SESSION_SECONDS=1800)
    def test_the_session_expires_after_the_configured_lifetime(self):
        client, token = self.csrf_client()
        self.sign_in(client, token)
        self.assertAlmostEqual(client.session.get_expiry_age(), 1800, delta=5)
        self.assertEqual(client.cookies["sessionid"]["max-age"], 1800)

    def test_the_lifetime_is_also_enforced_by_the_console_itself(self):
        client, token = self.csrf_client()
        self.sign_in(client, token)
        session = client.session
        session[CONSOLE_SESSION_KEY] = int(time.time()) - 43200 - 5
        session.save()
        self.assertFalse(client.get(SESSION).json()["authenticated"])

    def test_sign_in_rotates_the_session_and_the_csrf_token(self):
        client = Client(enforce_csrf_checks=True, raise_request_exception=False)
        token = client.get(SESSION).json()["csrfToken"]
        # A session that exists before sign-in (anonymous, with data in it).
        planted = client.session
        planted["planted"] = "by-an-attacker"
        planted.save()
        old_key = planted.session_key
        client.cookies["sessionid"] = old_key

        response = self.sign_in(client, token)
        self.assertEqual(response.status_code, 200)
        new_key = client.cookies["sessionid"].value
        self.assertNotEqual(new_key, old_key)
        self.assertFalse(Session.objects.filter(session_key=old_key).exists())  # the old key is dead server-side
        self.assertNotIn("planted", client.session)
        # The token from before sign-in no longer verifies; the one in the response does.
        self.assertEqual(self.post(client, token, LOGOUT, {}).status_code, 403)
        self.assertEqual(self.post(client, response.json()["csrfToken"], LOGOUT, {}).status_code, 200)

    def test_sign_in_requires_csrf(self):
        client = Client(enforce_csrf_checks=True, raise_request_exception=False)
        body = json.dumps({"username": "viewer", "password": PASSWORD})
        response = client.post(LOGIN, data=body, content_type="application/json")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        response = client.post(LOGIN, data=body, content_type="application/json", HTTP_X_CSRFTOKEN="not-the-token")
        self.assertEqual(response.status_code, 403)

    def test_failures_are_identical_for_every_reason(self):
        make_user("no-console", console=False)
        make_user("inactive", active=False)
        client, token = self.csrf_client()
        responses = [
            self.sign_in(client, token, "viewer", "wrong-password"),
            self.sign_in(client, token, "nobody-here", "whatever-password"),
            self.sign_in(client, token, "no-console", PASSWORD),  # right password, no console access
            self.sign_in(client, token, "inactive", PASSWORD),
        ]
        for response in responses:
            self.assertEqual(response.status_code, 401)
        self.assertEqual(len({r.content for r in responses}), 1)
        self.assertEqual(responses[0].json()["error"]["code"], "invalid_credentials")
        self.assertFalse(client.get(SESSION).json()["authenticated"])
        self.assertFalse(client.cookies.get("sessionid") and client.cookies["sessionid"].value)

    def test_malformed_requests(self):
        client, token = self.csrf_client()
        cases = [
            ("text/plain", "username=viewer&password=x", 415),
            ("application/json", "{not json", 400),
            ("application/json", "[]", 400),
            ("application/json", json.dumps({"username": "viewer"}), 400),
            ("application/json", json.dumps({"username": 5, "password": "x"}), 400),
            ("application/json", json.dumps({"username": "viewer", "password": ["x"]}), 400),
            ("application/json", json.dumps({"username": "", "password": "x"}), 400),
            ("application/json", json.dumps({"username": "   ", "password": "x"}), 400),
            ("application/json", json.dumps({"username": "v" * 151, "password": "x"}), 400),
            ("application/json", json.dumps({"username": "viewer", "password": ""}), 400),
            ("application/json", json.dumps({"username": "viewer", "password": "p" * 1025}), 400),
            ("application/json", json.dumps({"username": "viewer", "password": "x", "pad": "y" * 5000}), 413),
        ]
        for content_type, body, status in cases:
            with self.subTest(body=body[:30], status=status):
                response = self.post(client, token, LOGIN, body, content_type=content_type)
                self.assertEqual(response.status_code, status)
                self.assertIn("code", response.json()["error"])

    def test_text_the_database_or_hasher_cannot_handle_is_a_400_not_a_500(self):
        client, token = self.csrf_client()
        for username, password in (
            ("a\u0000b", "x"),
            ("\ud800", "x"),
            ("viewer", "pass\u0000word"),
            ("viewer", "\ud800"),
            ("viewer", "\udfff-trailing"),
        ):
            with self.subTest(username=username, password=password):
                body = json.dumps({"username": username, "password": password})  # ensure_ascii keeps the escapes
                response = self.post(client, token, LOGIN, body)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["code"], "invalid_request")
        self.assertEqual(LoginThrottle.objects.count(), 0)

    def test_the_password_is_used_exactly_as_typed(self):
        make_user("spacey", password="  pass word  ")
        client, token = self.csrf_client()
        self.assertEqual(self.sign_in(client, token, "spacey", "pass word").status_code, 401)  # not stripped
        self.assertEqual(self.sign_in(client, token, "spacey", "  pass word  ").status_code, 200)

    def test_the_body_limit_is_exact_and_the_declared_length_is_checked_first(self):
        client, token = self.csrf_client()
        base = json.dumps({"username": "viewer", "password": "x", "p": ""})
        exact = base[:-2] + "a" * (4096 - len(base)) + '"}'
        self.assertEqual(len(exact), 4096)
        self.assertEqual(self.post(client, token, LOGIN, exact).status_code, 401)  # accepted: wrong password, not 413
        self.assertEqual(self.post(client, token, LOGIN, exact[:-2] + 'a"}').status_code, 413)  # 4097
        # A declared length over the limit is refused without reading the body.
        small = json.dumps({"username": "viewer", "password": "x"})
        response = client.post(LOGIN, data=small, content_type="application/json", HTTP_X_CSRFTOKEN=token, CONTENT_LENGTH="999999")
        self.assertEqual(response.status_code, 413)
        response = client.post(LOGIN, data=small, content_type="application/json", HTTP_X_CSRFTOKEN=token, CONTENT_LENGTH="abc")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "invalid_request"))

    def test_the_documented_length_limits_are_inclusive(self):
        client, token = self.csrf_client()
        for username, password in (("v" * 150, "x"), ("viewer", "p" * 1024)):
            response = self.sign_in(client, token, username, password)
            self.assertEqual(response.status_code, 401)  # well-formed, simply wrong: not a 400

    def test_malformed_requests_do_not_count_as_password_attempts(self):
        client, token = self.csrf_client()
        for _ in range(10):
            self.post(client, token, LOGIN, "{broken")
        self.assertEqual(LoginThrottle.objects.count(), 0)

    def test_user_names_are_normalised_like_the_admin_login_form(self):
        client, token = self.csrf_client()
        # Full-width letters and surrounding spaces, as a form would deliver them.
        response = self.sign_in(client, token, "  ｖｉｅｗｅｒ ", PASSWORD)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["user"]["username"], "viewer")

    def test_get_is_not_allowed(self):
        self.assertEqual(Client().get(LOGIN).status_code, 405)

    def test_passwords_are_never_logged(self):
        client, token = self.csrf_client()
        secret = "do-not-log-this-Pa55word"
        with self.assertLogs("apps.console", level="INFO") as logs:
            self.sign_in(client, token, "viewer", secret)
            self.sign_in(client, token, "viewer", PASSWORD)
        text = "\n".join(logs.output)
        self.assertNotIn(secret, text)
        self.assertNotIn(PASSWORD, text)
        self.assertNotIn("viewer", text)  # accounts are logged by id, never by the name typed

    def test_signing_in_as_someone_else_replaces_the_session(self):
        make_user("second")
        client, token = self.csrf_client()
        self.sign_in(client, token, "viewer")
        token = client.get(SESSION).json()["csrfToken"]
        self.sign_in(client, token, "second")
        self.assertEqual(client.get(SESSION).json()["user"]["username"], "second")

    def test_changing_the_password_ends_existing_sessions(self):
        client = signed_in_client(self.user)
        self.assertTrue(client.get(SESSION).json()["authenticated"])
        self.user.set_password("a-completely-new-Passw0rd")
        self.user.save()
        self.assertFalse(client.get(SESSION).json()["authenticated"])

    def test_revoking_the_permission_applies_to_the_next_request(self):
        client = signed_in_client(make_user("temp", all_customers=True))
        self.assertEqual(client.get(SCOPE).status_code, 200)
        from django.contrib.auth import get_user_model

        get_user_model().objects.get(username="temp").user_permissions.clear()
        self.assertEqual(client.get(SCOPE).status_code, 403)


class SignOutTests(ConsoleTestCase):
    def test_sign_out_ends_the_session(self):
        make_user("viewer")
        client, token = self.csrf_client()
        self.sign_in(client, token)
        token = client.get(SESSION).json()["csrfToken"]
        response = self.post(client, token, LOGOUT, {})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["authenticated"])
        self.assertFalse(client.get(SESSION).json()["authenticated"])
        self.assertFalse(Session.objects.exists())  # the server-side session is gone, not just the cookie

    def test_sign_out_requires_csrf_and_post(self):
        client = signed_in_client(make_user("viewer"), enforce_csrf=True)
        self.assertEqual(client.post(LOGOUT).status_code, 403)
        self.assertEqual(client.get(LOGOUT).status_code, 405)
        self.assertTrue(client.get(SESSION).json()["authenticated"])  # still signed in

    def test_signing_out_when_not_signed_in_is_harmless(self):
        client, token = self.csrf_client()
        self.assertEqual(self.post(client, token, LOGOUT, {}).status_code, 200)


class ThrottleBehaviourTests(ConsoleTestCase):
    """Throttled and failed attempts are indistinguishable (no user-name oracle)."""

    def setUp(self):
        self.user = make_user("viewer")
        self.client_, self.token = self.csrf_client()

    def attempt(self, username="viewer", password="wrong-password"):
        return self.sign_in(self.client_, self.token, username, password)

    def lock_everything_unknown(self):
        now = timezone.now()
        LoginThrottle.objects.bulk_create(
            [
                LoginThrottle(key=f"x:{bucket}", attempts=5, window_started_at=now, locked_until=now + timedelta(hours=1))
                for bucket in range(1024)
            ],
            ignore_conflicts=True,
        )
        LoginThrottle.objects.filter(key__startswith="x:").update(locked_until=now + timedelta(hours=1))

    def test_after_five_failures_even_the_right_password_is_refused_with_the_same_answer(self):
        failures = [self.attempt() for _ in range(5)]
        locked = self.attempt(password=PASSWORD)
        self.assertEqual(locked.status_code, 401)
        self.assertEqual({r.content for r in failures}, {locked.content})
        self.assertNotIn("Retry-After", locked)
        self.assertFalse(self.client_.get(SESSION).json()["authenticated"])
        self.assertTrue(LoginThrottle.objects.get(key=f"u:{self.user.pk}").locked_until)

    def test_a_locked_account_is_never_compared_with_its_stored_hash(self):
        for _ in range(6):
            self.attempt()
        with (
            patch("apps.console.views.authenticate", wraps=real_authenticate) as authenticate,
            patch("apps.console.views.make_password", wraps=make_password) as hashing,
        ):
            self.attempt(password=PASSWORD)
        self.assertEqual(authenticate.call_count, 0)  # no comparison that could be timed or rehash a stale hash
        self.assertEqual(hashing.call_count, 1)  # but the same amount of hashing work as for an unknown name

    @override_settings(
        PASSWORD_HASHERS=[
            "django.contrib.auth.hashers.PBKDF2PasswordHasher",  # the current hasher...
            "django.contrib.auth.hashers.MD5PasswordHasher",
        ]
    )
    def test_a_locked_account_with_an_out_of_date_hash_is_not_rehashed_by_the_right_password(self):
        # ...so a hash with fewer iterations is out of date: a successful check would rewrite it.
        stale = PBKDF2PasswordHasher().encode(PASSWORD, "somesalt", iterations=100_000)
        type(self.user).objects.filter(pk=self.user.pk).update(password=stale)
        for _ in range(6):
            self.attempt()
        before = type(self.user).objects.get(pk=self.user.pk).password
        self.attempt(password=PASSWORD)
        self.assertEqual(type(self.user).objects.get(pk=self.user.pk).password, before)  # untouched while locked

    @override_settings(
        PASSWORD_HASHERS=[
            "django.contrib.auth.hashers.PBKDF2PasswordHasher",
            "django.contrib.auth.hashers.MD5PasswordHasher",
        ]
    )
    def test_accounts_that_can_never_sign_in_are_not_compared_with_their_stored_hash(self):
        stale = PBKDF2PasswordHasher().encode(PASSWORD, "somesalt", iterations=100_000)
        for name, kwargs in (("inactive", {"active": False}), ("no-console", {"console": False})):
            user = make_user(name, **kwargs)
            type(user).objects.filter(pk=user.pk).update(password=stale)
            client, token = self.csrf_client()
            with patch("apps.console.views.authenticate", wraps=real_authenticate) as authenticate:
                response = self.sign_in(client, token, name, PASSWORD)  # the RIGHT password
            self.assertEqual(response.status_code, 401, name)
            self.assertEqual(authenticate.call_count, 0, name)  # nothing to time, nothing to rehash
            self.assertEqual(type(user).objects.get(pk=user.pk).password, stale, name)

    def test_the_attempt_is_counted_before_the_password_is_checked(self):
        seen = {}

        def spy(request, username, password):
            seen["attempts"] = LoginThrottle.objects.get(key=f"u:{self.user.pk}").attempts
            return real_authenticate(request, username=username, password=password)

        with patch("apps.console.views.authenticate", side_effect=spy):
            self.attempt(password=PASSWORD)
        self.assertEqual(seen["attempts"], 1)  # already counted when the password was being verified

    def test_a_successful_sign_in_clears_only_that_accounts_row(self):
        make_user("other")
        for _ in range(3):
            self.attempt("other")
        for _ in range(2):
            self.attempt("ghost")
        for _ in range(2):
            self.attempt("viewer")
        self.assertEqual(self.attempt("viewer", PASSWORD).status_code, 200)
        keys = set(LoginThrottle.objects.values_list("key", flat=True))
        self.assertNotIn(f"u:{self.user.pk}", keys)
        self.assertEqual(len(keys), 2)  # "other" and the ghost bucket are untouched
        self.assertEqual(LoginThrottle.objects.get(user__username="other").attempts, 3)

    def test_a_saturated_unknown_name_bucket_reveals_nothing_about_which_names_exist(self):
        self.lock_everything_unknown()
        known = self.attempt("viewer", "wrong-password")
        unknown = self.attempt("bob-does-not-exist", "wrong-password")
        self.assertEqual((known.status_code, unknown.status_code), (401, 401))
        self.assertEqual(known.content, unknown.content)
        self.assertEqual(self.attempt("viewer", PASSWORD).status_code, 200)  # and real accounts are unaffected

    def test_unknown_names_are_throttled_but_look_exactly_like_any_failure(self):
        responses = [self.attempt("ghost") for _ in range(8)]
        self.assertEqual({r.status_code for r in responses}, {401})
        self.assertEqual(len({r.content for r in responses}), 1)
        self.assertTrue(LoginThrottle.objects.get(key=LoginThrottle.objects.filter(key__startswith="x:").first().key).locked_until)

    def test_a_successful_sign_in_clears_the_failures(self):
        for _ in range(4):
            self.attempt()
        self.assertEqual(self.attempt(password=PASSWORD).status_code, 200)
        self.assertFalse(LoginThrottle.objects.exists())
        self.client_, self.token = self.csrf_client()  # sign-in rotated the CSRF token
        for _ in range(5):
            self.assertEqual(self.attempt().status_code, 401)
        self.assertTrue(LoginThrottle.objects.get(key=f"u:{self.user.pk}").locked_until is None)

    def test_accounts_are_throttled_independently(self):
        make_user("other")
        for _ in range(6):
            self.attempt()
        self.assertEqual(self.attempt("other", PASSWORD).status_code, 200)

    def test_the_lock_ends_after_the_lockout(self):
        for _ in range(6):
            self.attempt()
        LoginThrottle.objects.update(locked_until=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.attempt(password=PASSWORD).status_code, 200)

    @override_settings(SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS=2, SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS=120)
    def test_limits_are_configurable(self):
        self.attempt()
        self.attempt()
        self.assertEqual(self.attempt(password=PASSWORD).status_code, 401)  # locked after two failures
        row = LoginThrottle.objects.get(key=f"u:{self.user.pk}")
        self.assertAlmostEqual((row.locked_until - timezone.now()).total_seconds(), 120, delta=5)

    def test_unknown_names_cannot_grow_the_table_without_bound(self):
        for index in range(1500):
            LoginThrottle.objects.get_or_create(key=f"x:{index % 1024}", defaults={"window_started_at": timezone.now()})
        for index in range(30):
            self.attempt(f"random-name-{index}")
        self.assertLessEqual(LoginThrottle.objects.filter(key__startswith="x:").count(), 1024)

    def test_unknown_name_buckets_do_not_lock_real_accounts(self):
        for index in range(200):
            self.attempt(f"ghost-{index}")
        self.assertEqual(self.attempt(password=PASSWORD).status_code, 200)
