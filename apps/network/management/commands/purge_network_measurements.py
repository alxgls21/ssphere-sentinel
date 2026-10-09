from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.core.retention import DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, delete_in_batches
from apps.network.models import NetworkMeasurement


class Command(BaseCommand):
    help = (
        "Delete network measurements older than "
        "SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS, in batches."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=None,
            help="Override retention days for this run.",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"Rows deleted per transaction (default {DEFAULT_BATCH_SIZE}).",
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
        batch_size = options["batch_size"]
        if not 1 <= batch_size <= MAX_BATCH_SIZE:
            self.stderr.write(f"--batch-size must be between 1 and {MAX_BATCH_SIZE}.")
            return

        cutoff = timezone.now() - timedelta(days=days)
        qs = NetworkMeasurement.objects.filter(measured_at__lt=cutoff)
        if options["dry_run"]:
            self.stdout.write(
                f"Would delete {qs.count()} measurement(s) older than {cutoff.isoformat()}."
            )
            return

        deleted, batches = delete_in_batches(qs, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} measurement row(s) older than {cutoff.isoformat()} "
                f"in {batches} batch(es)."
            )
        )
