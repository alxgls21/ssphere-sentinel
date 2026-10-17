"""Send one test email through the configured SMTP server, to check the settings.

    python manage.py send_test_email ops@example.com

It prints where it sent the email, or the kind of failure; never a credential, and
never the SMTP server's own message (which can echo what it was sent).
"""

from __future__ import annotations

from django.conf import settings
from django.core import mail
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.utils import timezone

from apps.alerts.models import DeliveryFailure
from apps.alerts.notifications import classify, email_enabled, password_missing, smtp_connection


class Command(BaseCommand):
    help = "Send a test email through the configured SMTP server."

    def add_arguments(self, parser):
        parser.add_argument("address", help="Where to send it.")

    def handle(self, *args, address: str, **options):
        if not email_enabled():
            raise CommandError("Email is off: SENTINEL_SMTP_HOST is not set.")
        if password_missing():
            raise CommandError(
                "SENTINEL_SMTP_USER is set without SENTINEL_SMTP_PASSWORD (run it in the notifier service, which has it)."
            )
        try:
            validate_email(address)
        except ValidationError:
            raise CommandError("That is not an email address.") from None
        server = f"{settings.SENTINEL_SMTP_HOST}:{settings.SENTINEL_SMTP_PORT} ({settings.SENTINEL_SMTP_SECURITY})"
        message = mail.EmailMessage(
            subject="[Sentinel] Test email",
            body=(
                f"This is a test email from SSphere Sentinel, sent at {timezone.now():%Y-%m-%d %H:%M UTC} "
                f"through {server}.\n\nIncident emails will come from this address.\n"
            ),
            from_email=settings.SENTINEL_EMAIL_FROM,
            to=[address],
            headers={"Auto-Submitted": "auto-generated"},
        )
        connection = smtp_connection()
        try:
            connection.send_messages([message])
        except Exception as error:  # noqa: BLE001 - reported by category only
            failure = classify(error)
            raise CommandError(f"Not sent: {DeliveryFailure(failure).label} ({failure}).") from None
        finally:
            try:
                connection.close()
            except Exception:  # noqa: BLE001
                pass
        self.stdout.write(f"Sent a test email to {address} through {server}.")
