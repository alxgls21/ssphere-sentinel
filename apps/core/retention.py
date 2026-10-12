"""Batched deletion and shared option handling for retention commands."""

from __future__ import annotations

from datetime import datetime, timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.models import QuerySet
from django.utils import timezone

DEFAULT_BATCH_SIZE = 5000
MAX_BATCH_SIZE = 100_000


def delete_in_batches(queryset: QuerySet, *, batch_size: int) -> tuple[int, int]:
    """Delete every row matching ``queryset`` in bounded batches.

    Each batch selects at most ``batch_size`` primary keys and deletes exactly
    those rows in its own transaction, so locks and WAL per transaction stay
    bounded and an interrupted run keeps the batches it already finished.
    The keys are fetched first because PostgreSQL may plan
    ``DELETE ... WHERE pk IN (SELECT ... LIMIT n)`` as a full table scan.
    Returns ``(rows_deleted, batches)``.
    """
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    manager = queryset.model._default_manager
    batch_ids = queryset.order_by().values_list("pk", flat=True)
    total = batches = 0
    while True:
        ids = list(batch_ids[:batch_size])
        if not ids:
            return total, batches
        deleted, _details = manager.filter(pk__in=ids).order_by().delete()
        total += deleted
        batches += 1
        if len(ids) < batch_size:
            return total, batches


class RetentionCommand(BaseCommand):
    """Shared ``--days/--batch-size/--dry-run`` handling for purge commands.

    Subclasses set ``default_days_setting`` and implement :meth:`purge`.
    Invalid options raise ``CommandError`` (non-zero exit) so a cron job or
    systemd timer notices a misconfigured cleanup.
    """

    default_days_setting: str

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=None,
            help=f"Override {self.default_days_setting} for this run.",
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
            days = getattr(settings, self.default_days_setting)
        if days <= 0:
            raise CommandError("Retention days must be a positive integer.")
        batch_size = options["batch_size"]
        if not 1 <= batch_size <= MAX_BATCH_SIZE:
            raise CommandError(f"--batch-size must be between 1 and {MAX_BATCH_SIZE}.")
        cutoff = timezone.now() - timedelta(days=days)
        self.purge(cutoff=cutoff, batch_size=batch_size, dry_run=options["dry_run"])

    def purge(self, *, cutoff: datetime, batch_size: int, dry_run: bool) -> None:
        raise NotImplementedError
