"""What the agent report ingests (network measurements, SNMP polls) share.

Each item of a report has an ID the agent chose; the acknowledgement says, per
ID, whether it is stored (``created``/``duplicate``) or rejected, and whether a
rejection is worth resending. The two ingests differ only in the name of that
ID (``ID_KEY``): ``measurement_id`` or ``poll_id``.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any


def acceptance_window(max_age_days: int, retention_days: int) -> timedelta:
    """How old a delayed item may be and still be stored.

    Capped at the retention period: older rows would be purged right away.
    """
    return timedelta(days=min(max_age_days, retention_days))


class Rejection:
    """Mixin for a frozen dataclass with an ``ID_KEY`` field (``str | None``), ``reason`` and ``retryable``."""

    ID_KEY: str

    def as_dict(self) -> dict[str, Any]:
        return {
            self.ID_KEY: getattr(self, self.ID_KEY),
            "reason": self.reason,
            "retryable": self.retryable,
        }


class IngestResult:
    """Mixin for a frozen dataclass with ``created``, ``duplicates``, ``rejections``,
    ``created_ids`` and ``duplicate_ids``."""

    ID_KEY: str

    def results(self) -> list[dict[str, Any]]:
        """Per-item acknowledgement, one entry per identifiable ID.

        Lets agents remove exactly the items that are stored (``created`` or
        ``duplicate``) and decide per rejection whether to resend. Rejections
        without a parseable ID, and repeats of an ID already listed (for example
        a duplicate inside one report), are omitted so every ID appears at most once.
        """
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for result, ids in (("created", self.created_ids), ("duplicate", self.duplicate_ids)):
            for item_id in ids:
                seen.add(item_id)
                entries.append({self.ID_KEY: item_id, "result": result})
        for rejection in self.rejections:
            item_id = getattr(rejection, self.ID_KEY)
            if item_id is None or item_id in seen:
                continue
            seen.add(item_id)
            entries.append({"result": "rejected", **rejection.as_dict()})
        return entries

    @property
    def accepted(self) -> int:
        """Items now stored server-side (new rows plus idempotent retries)."""
        return self.created + self.duplicates

    @property
    def rejected(self) -> int:
        return len(self.rejections)

    @property
    def status(self) -> str:
        if not self.rejections:
            return "accepted"
        if self.accepted == 0:
            return "rejected"
        return "partial"


def acknowledgement(prefix: str, noun: str, result: IngestResult) -> dict[str, Any]:
    """The keys an ingest adds to the heartbeat response (``network_*``, ``snmp_*``)."""
    response = {
        prefix: result.status,
        f"{prefix}_created": result.created,
        f"{prefix}_duplicates": result.duplicates,
        f"{prefix}_accepted": result.accepted,
        f"{prefix}_rejected": result.rejected,
        f"{prefix}_results": result.results(),
    }
    if result.rejections:
        response[f"{prefix}_rejections"] = [rejection.as_dict() for rejection in result.rejections]
        response[f"{prefix}_detail"] = f"{result.rejected} {noun}(s) rejected; first: {result.rejections[0].reason}"
    return response
