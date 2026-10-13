"""Pieces every console list endpoint shares: search, health counts, ordering, the page envelope."""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime

from django.db.models import Count, Q, QuerySet
from django.db.models.functions import Collate, Lower

from apps.console.health import HEALTH_NAMES, empty_counts
from apps.console.params import PageRequest
from apps.console.serializers import iso


def apply_search(queryset: QuerySet, words: Collection[str], fields: Collection[str]) -> QuerySet:
    """Keep rows where every word is found, case-insensitively, in at least one of ``fields``.

    ``icontains`` escapes ``%`` and ``_``, so a search for ``50%`` is literal.
    """
    for word in words:
        condition = Q()
        for field in fields:
            condition |= Q(**{f"{field}__icontains": word})
        queryset = queryset.filter(condition)
    return queryset


def counts_by_severity(queryset: QuerySet) -> dict[str, int]:
    """Rows per health status (the ``severity`` annotation), in one grouped query."""
    counts = empty_counts()
    for row in queryset.order_by().values("severity").annotate(n=Count("pk")):
        counts[HEALTH_NAMES[row["severity"]]] = row["n"]
    return counts


def name_order(field: str, *, descending: bool = False):
    """Case-insensitive ordering by byte value, not by the database's locale.

    Collations differ between PostgreSQL installations (and between the
    container image and a developer's machine); ``C`` does not, so a page
    boundary falls in the same place everywhere for ASCII names (``LOWER``
    still follows the database's character classes for other alphabets).
    The price is that digits are compared as text: ``web-10`` before ``web-2``.
    """
    expression = Collate(Lower(field), "C")
    return expression.desc() if descending else expression.asc()


def page_envelope(
    now: datetime,
    items: list[dict],
    page: PageRequest,
    *,
    total: int,
    counts: dict[str, int],
    scope_total: int,
) -> dict:
    """``{generatedAt, items, page, counts, scopeTotal}``.

    ``total`` is the rows matching every filter; ``counts`` the same without
    the status filter (what each status chip would show); ``scopeTotal`` the
    rows in the requested scope, before search and status.
    """
    return {
        "generatedAt": iso(now),
        "items": items,
        "page": page.payload(total),
        "counts": counts,
        "scopeTotal": scope_total,
    }
