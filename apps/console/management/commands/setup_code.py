"""The setup code that creates the first administrator, while the installation has no user (apps.console.setup).

The entrypoint runs it as the web service starts. With no user, it replaces the code and prints it; once a user
exists, it removes any code left and prints nothing.
"""

from django.core.management.base import BaseCommand

from apps.console.setup import prepare


class Command(BaseCommand):
    help = "Print a new setup code for the first administrator while there is no user; otherwise remove it."

    def handle(self, *args, **options):
        code = prepare()
        if code is None:
            return
        self.stdout.write(
            "setup: this installation has no administrator yet. Open the console and create one with the setup code\n"
            f"setup:     {code}\n"
            "setup: it works until the first administrator exists; every start of web prints a new one until then."
        )
