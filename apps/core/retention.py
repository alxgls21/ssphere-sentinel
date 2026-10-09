"""Batched deletion for retention management commands."""

from __future__ import annotations

from django.db.models import QuerySet

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
