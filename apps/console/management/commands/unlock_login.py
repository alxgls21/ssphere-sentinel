"""Unlock an account that the sign-in throttle has locked (apps.console.throttle).

The console sign-in and the admin login share one counter per account, so someone who knows an administrator's
user name can lock that administrator out of both for the lockout period. When the only administrator is locked
there is nobody left to delete the row in the admin: this command, run on the server, does it. It needs shell
access to the web service, not a sign-in.
"""

import unicodedata

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.console import throttle
from apps.console.http import storable_text
from apps.console.models import LoginThrottle


class Command(BaseCommand):
    help = (
        "Forget the failed sign-ins of one account (so a lockout ends now), or of everything with --all. "
        "Usage: manage.py unlock_login <username>"
    )

    def add_arguments(self, parser):
        parser.add_argument("username", nargs="?", help="The user name of the locked account.")
        parser.add_argument(
            "--all",
            action="store_true",
            help="Clear every login throttle row, including the shared buckets of user names that do not exist.",
        )

    def handle(self, *args, **options):
        # The sign-in forms drop the spaces around a name before they look it up; so does this.
        username, everything = (options["username"] or "").strip(), options["all"]
        if bool(username) == everything:  # neither, or both
            raise CommandError("Give a user name, or --all (not both).")
        if everything:
            deleted, _ = LoginThrottle.objects.all().delete()
            self.stdout.write(f"Cleared {deleted} login throttle row(s).")
            return

        User = get_user_model()
        field = User.USERNAME_FIELD
        # The sign-in forms look the name up as typed after Unicode NFKC normalisation; accept either spelling.
        # A name the database cannot be asked for (bytes on the command line that are not UTF-8) is nobody's.
        account = storable_text(username) and (
            User.objects.filter(**{field: username}).first()
            or User.objects.filter(**{field: unicodedata.normalize("NFKC", username)}).first()
        )
        if not account:
            raise CommandError(f"There is no account with the user name {username!r}.")
        if throttle.unlock(account.pk):
            self.stdout.write(f"Unlocked {account.get_username()!r}: its failed sign-ins are forgotten.")
        else:
            self.stdout.write(f"{account.get_username()!r} was not locked: no failed sign-ins are recorded for it.")
