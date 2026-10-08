from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.network.models import NetworkMeasurement


class Command(BaseCommand):
    help = (
        "Delete network measurements older than "
        "SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=None,
            help="Override retention days for this run.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show how many rows would be deleted without deleting.",
        )

    def handle(self, *args, **options):
        days = options["days"]
        if days is None:
            days = settings.SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS
        if days <= 0:
            self.stderr.write("Retention days must be a positive integer.")
            return

        cutoff = timezone.now() - timedelta(days=days)
        qs = NetworkMeasurement.objects.filter(measured_at__lt=cutoff)
        count = qs.count()
        if options["dry_run"]:
            self.stdout.write(
                f"Would delete {count} measurement(s) older than {cutoff.isoformat()}."
            )
            return

        deleted, _details = qs.delete()
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} measurement row(s) older than {cutoff.isoformat()}."
            )
        )
