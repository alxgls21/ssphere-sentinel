"""The admin login form, under the console's sign-in throttle (see apps.console.throttle).

Both doors count failures under the same per-account key (``u:<id>``), so one
lockout covers the console and the admin, and a successful sign-in at either
clears it. As in the console sign-in, the attempt is counted *before* the
password is checked, and only an active staff account that is not locked has
its password compared with the stored hash; every other attempt hashes the
password once (the work ``ModelBackend`` does for an unknown name) and gets the
admin's ordinary "Please enter the correct username and password" error.
"""

from __future__ import annotations

import logging

from django.contrib.admin.forms import AdminAuthenticationForm
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.exceptions import ValidationError
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from apps.console import throttle

logger = logging.getLogger("apps.console")


class ThrottledAdminAuthenticationForm(AdminAuthenticationForm):
    @sensitive_variables()
    def clean(self):
        username = self.cleaned_data.get("username")
        password = self.cleaned_data.get("password")
        if username is None or not password:
            return super().clean()  # an incomplete form: Django's own errors, nothing to count

        User = get_user_model()
        account = User.objects.filter(**{User.USERNAME_FIELD: username}).first()
        user_pk = account.pk if account else None
        key = throttle.throttle_key(username, user_pk)
        locked = throttle.begin_attempt(key, timezone.now(), user_id=user_pk) is not None
        eligible = account is not None and account.is_active and account.is_staff
        if locked or not eligible:
            make_password(password)
            logger.warning("Admin sign-in failed (account=%s, locked=%s)", key, locked)
            raise self.get_invalid_login_error()
        try:
            super().clean()  # authenticate() and the admin's own checks
        except ValidationError:
            logger.warning("Admin sign-in failed (account=%s, locked=%s)", key, locked)
            raise
        throttle.clear(key)
        logger.info("Admin sign-in (user_id=%s)", self.user_cache.pk)
        return self.cleaned_data
