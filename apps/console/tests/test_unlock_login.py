"""manage.py unlock_login: an administrator locked out by the sign-in throttle gets back in without signing in."""

from io import StringIO

from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.console import throttle
from apps.console.models import LoginThrottle
from apps.console.tests.helpers import make_user

PINNED = {"SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS": 5, "SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS": 900}


def run(*args) -> str:
    out = StringIO()
    call_command("unlock_login", *args, stdout=out)
    return out.getvalue()


@override_settings(**PINNED)
class UnlockLoginTests(TestCase):
    def setUp(self):
        self.now = timezone.now()

    def lock(self, key, user_id=None):
        for _ in range(6):
            throttle.begin_attempt(key, self.now, user_id=user_id)
        self.assertEqual(throttle.begin_attempt(key, self.now), 900)  # it is locked

    def test_the_named_account_is_unlocked_and_nobody_else(self):
        alice = make_user("alice", superuser=True)
        bob = make_user("bob")
        alice_key, bob_key = f"u:{alice.pk}", f"u:{bob.pk}"
        self.lock(alice_key, alice.pk)
        self.lock(bob_key, bob.pk)

        message = run("alice")

        self.assertIn("Unlocked 'alice'", message)
        self.assertFalse(LoginThrottle.objects.filter(key=alice_key).exists())
        self.assertIsNone(throttle.begin_attempt(alice_key, self.now, user_id=alice.pk))  # may try again
        self.assertEqual(throttle.begin_attempt(bob_key, self.now), 900)  # bob is still locked

    def test_an_account_that_is_not_locked_is_said_not_to_be(self):
        make_user("carol")
        self.assertIn("was not locked", run("carol"))
        self.assertEqual(LoginThrottle.objects.count(), 0)

    def test_the_other_spelling_of_a_name_finds_the_account(self):
        user = make_user("admin", superuser=True)
        self.lock(f"u:{user.pk}", user.pk)
        run("ａｄｍｉｎ")  # the same name in full-width letters (Unicode NFKC)
        self.assertFalse(LoginThrottle.objects.filter(key=f"u:{user.pk}").exists())

    def test_spaces_around_the_name_are_ignored_as_the_sign_in_forms_ignore_them(self):
        user = make_user("heidi")
        self.lock(f"u:{user.pk}", user.pk)
        run(" heidi ")
        self.assertFalse(LoginThrottle.objects.filter(key=f"u:{user.pk}").exists())

    def test_an_unknown_name_is_an_error_and_changes_nothing(self):
        other = make_user("dave")
        self.lock(f"u:{other.pk}", other.pk)
        with self.assertRaisesMessage(CommandError, "There is no account"):
            run("nobody")
        self.assertTrue(LoginThrottle.objects.filter(key=f"u:{other.pk}").exists())

    def test_a_name_the_database_cannot_hold_is_an_unknown_name_not_a_traceback(self):
        # Bytes on the command line that are not UTF-8 reach the command as lone surrogates.
        other = make_user("grace")
        self.lock(f"u:{other.pk}", other.pk)
        with self.assertRaisesMessage(CommandError, "There is no account"):
            run("gr\udcffce")
        self.assertTrue(LoginThrottle.objects.filter(key=f"u:{other.pk}").exists())

    def test_all_clears_every_row_including_the_shared_buckets(self):
        user = make_user("erin")
        self.lock(f"u:{user.pk}", user.pk)
        self.lock("x:7")
        self.assertIn("Cleared 2 login throttle row(s)", run("--all"))
        self.assertEqual(LoginThrottle.objects.count(), 0)

    def test_it_needs_a_name_or_all_but_not_both(self):
        user = make_user("frank")
        self.lock(f"u:{user.pk}", user.pk)
        for args in ((), ("frank", "--all")):
            with self.subTest(args=args):
                with self.assertRaisesMessage(CommandError, "Give a user name, or --all"):
                    run(*args)
        self.assertTrue(LoginThrottle.objects.filter(key=f"u:{user.pk}").exists())
