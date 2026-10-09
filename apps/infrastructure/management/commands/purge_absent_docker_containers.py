from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.core.retention import DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, delete_in_batches
from apps.infrastructure.models import DockerContainer


class Command(BaseCommand):
    help = (
        "Delete Docker containers that have been absent from successful "
        "discoveries for longer than SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS. "
        "Present containers are never deleted."
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
            help="Show how many containers would be deleted without deleting.",
        )

    def handle(self, *args, **options):
        days = options["days"]
        if days is None:
            days = settings.SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS
        if days <= 0:
            self.stderr.write("Retention days must be a positive integer.")
            return
        batch_size = options["batch_size"]
        if not 1 <= batch_size <= MAX_BATCH_SIZE:
            self.stderr.write(f"--batch-size must be between 1 and {MAX_BATCH_SIZE}.")
            return

        cutoff = timezone.now() - timedelta(days=days)
        # Containers only become absent after a successful discovery that no
        # longer lists them, so Docker outages never make rows eligible here.
        qs = DockerContainer.objects.filter(present=False, last_seen_at__lt=cutoff)
        if options["dry_run"]:
            self.stdout.write(
                f"Would delete {qs.count()} absent container(s) last seen before "
                f"{cutoff.isoformat()}."
            )
            return

        deleted, batches = delete_in_batches(qs, batch_size=batch_size)
        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} absent container(s) last seen before "
                f"{cutoff.isoformat()} in {batches} batch(es)."
            )
        )
