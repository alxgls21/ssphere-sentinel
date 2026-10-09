"""Interpret the server's network acknowledgement for a sent batch.

The agent only removes a queued measurement when the response identifies it
explicitly. Anything ambiguous leaves the measurement queued.

Supported response shapes, newest first:

1. ``network_results`` (per-measurement): each entry has ``measurement_id`` and
   ``result`` = ``created`` | ``duplicate`` | ``rejected`` (+ ``retryable``).
2. Phase-1 servers: ``network_rejections`` with IDs plus counts. Remaining
   measurements are acknowledged only if the counts match exactly.
3. Older servers: ``network: accepted`` with ``network_created +
   network_duplicates`` equal to the number sent.

Any other shape (malformed JSON, missing/unknown ``network`` status, a
section-level rejection, inconsistent counts) is a batch failure: nothing is
removed and delivery backs off.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field

STORED_RESULTS = frozenset({"created", "duplicate"})
KNOWN_STATUSES = frozenset({"accepted", "partial", "rejected"})
# Phase-1 servers did not send ``retryable``; this was their only storage failure.
LEGACY_RETRYABLE_REASONS = frozenset({"measurement could not be stored"})


@dataclass(frozen=True)
class Acknowledgement:
    stored: frozenset[str] = frozenset()
    permanent: dict[str, str] = field(default_factory=dict)
    retryable: dict[str, str] = field(default_factory=dict)
    unresolved: frozenset[str] = frozenset()
    batch_failure: str | None = None

    @property
    def is_batch_failure(self) -> bool:
        return self.batch_failure is not None


def parse_acknowledgement(body: str, sent_ids: Sequence[str]) -> Acknowledgement:
    sent = list(dict.fromkeys(sent_ids))
    if not sent:
        return Acknowledgement()

    try:
        data = json.loads(body) if body and body.strip() else None
    except ValueError:
        return Acknowledgement(batch_failure="response is not valid JSON")
    if not isinstance(data, dict):
        return Acknowledgement(batch_failure="response is not a JSON object")

    status = data.get("network")
    if status is None:
        return Acknowledgement(batch_failure="response has no network acknowledgement")
    if status not in KNOWN_STATUSES:
        return Acknowledgement(batch_failure="response has an unknown network status")

    results = data.get("network_results")
    if results is not None:
        return _from_results(results, sent)
    return _from_legacy(data, status, sent)


def _from_results(results: object, sent: list[str]) -> Acknowledgement:
    if not isinstance(results, list):
        return Acknowledgement(batch_failure="network_results is not a list")

    sent_set = set(sent)
    outcomes: dict[str, tuple[str, str, bool]] = {}
    conflicting: set[str] = set()
    for entry in results:
        if not isinstance(entry, dict):
            continue
        measurement_id = entry.get("measurement_id")
        result = entry.get("result")
        if measurement_id not in sent_set or not isinstance(result, str):
            continue
        reason = entry.get("reason")
        reason_text = reason if isinstance(reason, str) else ""
        retryable_flag = entry.get("retryable")
        # A rejection with a missing/invalid flag is kept for retry (safe default).
        retryable = retryable_flag if isinstance(retryable_flag, bool) else True
        outcome = (result, reason_text, retryable)
        if measurement_id in outcomes and outcomes[measurement_id] != outcome:
            conflicting.add(measurement_id)
        outcomes[measurement_id] = outcome

    stored: set[str] = set()
    permanent: dict[str, str] = {}
    retryable: dict[str, str] = {}
    for measurement_id, (result, reason, is_retryable) in outcomes.items():
        if measurement_id in conflicting:
            continue
        if result in STORED_RESULTS:
            stored.add(measurement_id)
        elif result == "rejected":
            (retryable if is_retryable else permanent)[measurement_id] = reason
    resolved = stored | set(permanent) | set(retryable)
    return Acknowledgement(
        stored=frozenset(stored),
        permanent=permanent,
        retryable=retryable,
        unresolved=frozenset(sent_set - resolved),
    )


def _from_legacy(data: dict, status: str, sent: list[str]) -> Acknowledgement:
    sent_set = set(sent)
    rejections = data.get("network_rejections")

    if rejections is None:
        if status != "accepted":
            detail = data.get("network_detail")
            return Acknowledgement(
                batch_failure="network section rejected"
                + (f": {detail[:200]}" if isinstance(detail, str) else "")
            )
        if _legacy_stored_count(data) != len(sent):
            return Acknowledgement(batch_failure="network counts do not match the batch")
        return Acknowledgement(stored=frozenset(sent_set))

    if not isinstance(rejections, list):
        return Acknowledgement(batch_failure="network_rejections is not a list")
    permanent: dict[str, str] = {}
    retryable: dict[str, str] = {}
    for entry in rejections:
        if not isinstance(entry, dict):
            return Acknowledgement(batch_failure="network_rejections entry is malformed")
        measurement_id = entry.get("measurement_id")
        if measurement_id not in sent_set:
            return Acknowledgement(batch_failure="rejection does not match the batch")
        reason = entry.get("reason") if isinstance(entry.get("reason"), str) else ""
        if reason in LEGACY_RETRYABLE_REASONS:
            retryable[measurement_id] = reason
        else:
            permanent[measurement_id] = reason

    rejected_ids = set(permanent) | set(retryable)
    remaining = sent_set - rejected_ids
    accepted_count = _as_int(data.get("network_accepted"))
    if accepted_count is None:
        accepted_count = _legacy_stored_count(data)
    if accepted_count != len(remaining) or len(rejected_ids) != len(rejections):
        return Acknowledgement(batch_failure="network counts do not match the batch")
    return Acknowledgement(
        stored=frozenset(remaining),
        permanent=permanent,
        retryable=retryable,
    )


def _legacy_stored_count(data: dict) -> int | None:
    created = _as_int(data.get("network_created"))
    duplicates = _as_int(data.get("network_duplicates"))
    if created is None or duplicates is None:
        return None
    return created + duplicates


def _as_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value
