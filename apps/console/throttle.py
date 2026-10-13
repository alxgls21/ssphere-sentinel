"""Throttling of console login attempts (password guessing).

Limits are per account, not per client address: Django never trusts
``X-Forwarded-For`` here (see docs/security.md), so behind a proxy every
client has the same address. The price is that someone who knows a user name
can lock that account for ``SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS``; an
administrator can unlock it (Login throttles, in the admin).

An attempt is counted *before* the password is checked and the counter is
cleared by a successful login. That makes the limit exact under concurrency:
a burst of parallel guesses cannot all pass the check before any of them has
failed.

A locked account is **not** answered differently: it gets the same answer as
any other failure, after the same amount of work (the caller hashes the password
once, as for an unknown user name, but never compares it with the stored hash).
Anything else (a distinct status, a quicker reply, a comparison that can be
timed) would tell an attacker which user names exist, because names that do not
exist share buckets and are locked by other names' failures.
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction

from apps.console.models import LoginThrottle

UNKNOWN_BUCKETS = 1024
# Rows untouched for this long are removed whenever a new row is created.
STALE_AFTER = timedelta(days=1)


def throttle_key(username: str, user_pk: int | None) -> str:
    """``u:<id>`` for an existing account, else one of ``UNKNOWN_BUCKETS`` shared keys."""
    if user_pk is not None:
        return f"u:{user_pk}"
    digest = hashlib.sha256(username.encode("utf-8")).digest()
    return f"x:{int.from_bytes(digest[:4], 'big') % UNKNOWN_BUCKETS}"


def begin_attempt(key: str, now: datetime, *, user_id: int | None = None) -> int | None:
    """Count one attempt (``user_id``: the account, if it exists; shown in the admin). ``None`` if it may proceed, else seconds until the next one is allowed."""
    # Creating the row can lose a race against another request that creates
    # and then (after a successful sign-in) deletes it, or against the deletion
    # of the account itself; both are retried, never surfaced as an error.
    for attempt in range(3):
        try:
            return _count_attempt(key, now, user_id)
        except IntegrityError:
            if attempt == 2:
                raise
            if user_id is not None and not get_user_model().objects.filter(pk=user_id).exists():
                user_id = None  # the account was deleted meanwhile: count it like an unknown name
    raise AssertionError("unreachable")  # pragma: no cover


def _count_attempt(key: str, now: datetime, user_id: int | None) -> int | None:
    max_attempts = settings.SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS
    lockout = timedelta(seconds=settings.SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS)
    with transaction.atomic():
        row, created = LoginThrottle.objects.select_for_update().get_or_create(
            key=key, defaults={"window_started_at": now, "user_id": user_id}
        )
        if created:
            LoginThrottle.objects.filter(updated_at__lt=now - max(STALE_AFTER, 2 * lockout)).delete()
        if row.locked_until is not None and row.locked_until > now:
            return max(1, math.ceil((row.locked_until - now).total_seconds()))
        if row.locked_until is not None or now - row.window_started_at >= lockout:
            row.attempts = 0
            row.window_started_at = now
            row.locked_until = None
        if row.attempts >= max_attempts:
            row.locked_until = now + lockout
            row.save(update_fields=["locked_until", "updated_at"])
            return max(1, math.ceil(lockout.total_seconds()))
        row.attempts += 1
        row.save(update_fields=["attempts", "window_started_at", "locked_until", "updated_at"])
        return None


def clear(key: str) -> None:
    """A successful login forgets earlier failures."""
    LoginThrottle.objects.filter(key=key).delete()
