"""The login throttle service, including under concurrency."""

import threading
from datetime import timedelta

from unittest.mock import patch

from django.db import IntegrityError, connection
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from apps.console import throttle
from apps.console.models import LoginThrottle


PINNED = {"SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS": 5, "SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS": 900}


@override_settings(**PINNED)
class ThrottleServiceTests(TestCase):
    def setUp(self):
        self.now = timezone.now()

    def test_keys(self):
        self.assertEqual(throttle.throttle_key("anyone", 7), "u:7")
        key = throttle.throttle_key("ghost", None)
        self.assertRegex(key, r"^x:\d{1,4}$")
        self.assertEqual(key, throttle.throttle_key("ghost", None))

    def test_unknown_names_share_exactly_1024_buckets(self):
        self.assertEqual(throttle.UNKNOWN_BUCKETS, 1024)  # the documented bound on the table
        keys = {throttle.throttle_key(f"random-name-{i}", None) for i in range(20_000)}
        self.assertLessEqual(len(keys), 1024)
        self.assertGreater(len(keys), 1000)  # and the names spread over (almost) all of them
        self.assertTrue(all(0 <= int(key[2:]) < 1024 for key in keys))
        # An existing account never lands in a bucket, whatever its name hashes to.
        self.assertTrue(throttle.throttle_key("ghost", 5).startswith("u:"))

    def test_the_account_is_recorded_for_existing_users_only(self):
        from apps.console.tests.helpers import make_user

        user = make_user("alice")
        key = f"u:{user.pk}"  # read before the delete: afterwards the pk is None
        throttle.begin_attempt(key, self.now, user_id=user.pk)
        throttle.begin_attempt("x:7", self.now)
        self.assertEqual(LoginThrottle.objects.get(key=key).user, user)
        self.assertIsNone(LoginThrottle.objects.get(key="x:7").user)
        user.delete()
        self.assertFalse(LoginThrottle.objects.filter(key=key).exists())  # the row goes with the account
        self.assertTrue(LoginThrottle.objects.filter(key="x:7").exists())

    def test_five_attempts_pass_then_the_account_locks(self):
        results = [throttle.begin_attempt("u:1", self.now) for _ in range(7)]
        self.assertEqual(results[:5], [None] * 5)
        self.assertEqual(results[5], 900)
        self.assertEqual(results[6], 900)

    def test_the_wait_shrinks_as_time_passes(self):
        for _ in range(6):
            throttle.begin_attempt("u:1", self.now)
        self.assertEqual(throttle.begin_attempt("u:1", self.now + timedelta(seconds=600)), 300)

    def test_after_the_lockout_the_counter_starts_over(self):
        for _ in range(6):
            throttle.begin_attempt("u:1", self.now)
        later = self.now + timedelta(seconds=901)
        self.assertIsNone(throttle.begin_attempt("u:1", later))
        row = LoginThrottle.objects.get(key="u:1")
        self.assertEqual((row.attempts, row.locked_until), (1, None))

    def test_failures_older_than_the_window_do_not_accumulate(self):
        for _ in range(4):
            throttle.begin_attempt("u:1", self.now)
        later = self.now + timedelta(seconds=901)
        for _ in range(5):
            self.assertIsNone(throttle.begin_attempt("u:1", later))

    def test_the_limit_applies_again_after_a_lock_has_expired(self):
        for _ in range(6):
            throttle.begin_attempt("u:1", self.now)
        after = self.now + timedelta(seconds=900)  # exactly when the lock ends: allowed again
        results = [throttle.begin_attempt("u:1", after) for _ in range(7)]
        self.assertEqual(results[:5], [None] * 5)
        self.assertEqual(results[5], 900)  # ...and the sixth attempt locks it again
        self.assertEqual(results[6], 900)

    def test_the_limit_applies_again_after_a_window_without_a_lock(self):
        for _ in range(3):
            throttle.begin_attempt("u:1", self.now)
        later = self.now + timedelta(seconds=900)  # exactly one lockout after the window began: a new window
        results = [throttle.begin_attempt("u:1", later) for _ in range(6)]
        self.assertEqual(results[:5], [None] * 5)
        self.assertEqual(results[5], 900)
        row = LoginThrottle.objects.get(key="u:1")
        self.assertEqual(row.window_started_at, later)  # the new window started when it was reset

    def test_boundaries_of_the_lock_and_of_the_window(self):
        for _ in range(6):
            throttle.begin_attempt("u:1", self.now)
        locked_until = LoginThrottle.objects.get(key="u:1").locked_until
        just_before = locked_until - timedelta(milliseconds=1)
        self.assertEqual(throttle.begin_attempt("u:1", just_before), 1)  # still locked, rounded up to a second
        self.assertEqual(throttle.begin_attempt("u:1", locked_until - timedelta(seconds=599, milliseconds=500)), 600)
        self.assertEqual(throttle.begin_attempt("u:1", locked_until - timedelta(seconds=300, milliseconds=500)), 301)
        self.assertIsNone(throttle.begin_attempt("u:1", locked_until))  # at the instant: free

    def test_a_window_one_second_short_of_the_lockout_is_still_the_same_window(self):
        for _ in range(4):
            throttle.begin_attempt("u:1", self.now)
        almost = self.now + timedelta(seconds=899)
        self.assertIsNone(throttle.begin_attempt("u:1", almost))  # the fifth attempt of the same window
        self.assertEqual(throttle.begin_attempt("u:1", almost), 900)  # the sixth is locked

    def test_clear_forgets_everything(self):
        throttle.begin_attempt("u:1", self.now)
        throttle.clear("u:1")
        self.assertFalse(LoginThrottle.objects.filter(key="u:1").exists())
        throttle.clear("u:1")  # idempotent

    def test_stale_rows_are_removed_when_a_new_one_is_created(self):
        LoginThrottle.objects.create(key="u:old", attempts=3, window_started_at=self.now)
        LoginThrottle.objects.filter(key="u:old").update(updated_at=self.now - timedelta(days=3))
        throttle.begin_attempt("u:new", self.now)
        self.assertEqual(list(LoginThrottle.objects.values_list("key", flat=True)), ["u:new"])

    @override_settings(SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS=1)
    def test_a_limit_of_one(self):
        self.assertIsNone(throttle.begin_attempt("u:1", self.now))
        self.assertEqual(throttle.begin_attempt("u:1", self.now), 900)

    def test_losing_the_creation_race_is_retried_not_an_error(self):
        real = throttle._count_attempt
        calls = []

        def flaky(key, now, user_id):
            calls.append(key)
            if len(calls) < 3:
                raise IntegrityError("duplicate key value violates unique constraint")
            return real(key, now, user_id)

        with patch.object(throttle, "_count_attempt", side_effect=flaky):
            self.assertIsNone(throttle.begin_attempt("u:1", self.now))
        self.assertEqual(len(calls), 3)

    def test_a_persistent_integrity_error_is_not_swallowed(self):
        with patch.object(throttle, "_count_attempt", side_effect=IntegrityError("always")):
            with self.assertRaises(IntegrityError):
                throttle.begin_attempt("u:1", self.now)


@override_settings(**PINNED)
class ThrottleConcurrencyTests(TransactionTestCase):
    def test_an_account_deleted_during_sign_in_is_counted_like_an_unknown_name(self):
        from apps.console.tests.helpers import make_user

        user = make_user("short-lived")
        pk = user.pk
        user.delete()  # between the lookup in the view and the counting
        self.assertIsNone(throttle.begin_attempt(f"u:{pk}", timezone.now(), user_id=pk))  # no IntegrityError, no 500
        row = LoginThrottle.objects.get(key=f"u:{pk}")
        self.assertIsNone(row.user_id)
        self.assertEqual(row.attempts, 1)

    def test_parallel_attempts_cannot_exceed_the_limit(self):
        now = timezone.now()
        barrier = threading.Barrier(16)
        results, errors = [], []

        def worker():
            try:
                barrier.wait(timeout=10)
                results.append(throttle.begin_attempt("u:race", now))
            except Exception as exc:  # noqa: BLE001 - surfaced by the assertion
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker) for _ in range(16)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(errors, [])
        self.assertEqual(sum(1 for r in results if r is None), 5)
        self.assertEqual(sum(1 for r in results if r is not None), 11)
        self.assertEqual(LoginThrottle.objects.filter(key="u:race").count(), 1)
