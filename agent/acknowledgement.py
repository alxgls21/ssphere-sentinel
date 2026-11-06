"""Interpret the server's acknowledgement of a sent batch (network or SNMP).

The agent only removes a queued item when the response identifies it
explicitly. Anything ambiguous leaves the item queued.

Both sections use the same envelope, ``<section>``, ``<section>_results``,
differing in the section name and in the key that identifies an item
(``measurement_id`` for network, ``poll_id`` for SNMP): each entry of
``<section>_results`` has the item's id and ``result`` = ``created`` |
``duplicate`` | ``rejected`` (+ ``retryable``).

Any other shape (malformed JSON, missing/unknown status, a section-level
rejection, counts without per-item results) is a batch failure: nothing is
removed and delivery backs off.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field

from agent.errors import safe_text

STORED_RESULTS = frozenset({"created", "duplicate"})
KNOWN_STATUSES = frozenset({"accepted", "partial", "rejected"})


@dataclass(frozen=True)
class AckSection:
    """How one heartbeat section is acknowledged."""

    name: str  # key of the section status in the response, e.g. "network"
    id_key: str  # key that identifies an item inside ``<name>_results``


NETWORK = AckSection("network", "measurement_id")
SNMP = AckSection("snmp", "poll_id")


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


def parse_acknowledgement(
    body: str, sent_ids: Sequence[str], section: AckSection = NETWORK
) -> Acknowledgement:
    sent = list(dict.fromkeys(sent_ids))
    if not sent:
        return Acknowledgement()

    try:
        data = json.loads(body) if body and body.strip() else None
    except (ValueError, RecursionError):  # RecursionError: a body nested thousands of levels deep
        return Acknowledgement(batch_failure="response is not valid JSON")
    if not isinstance(data, dict):
        return Acknowledgement(batch_failure="response is not a JSON object")

    status = data.get(section.name)
    if status is None:
        return Acknowledgement(batch_failure=f"response has no {section.name} acknowledgement")
    # ``in`` on a frozenset raises for an unhashable value ({"snmp": []}).
    if not isinstance(status, str) or status not in KNOWN_STATUSES:
        return Acknowledgement(batch_failure=f"response has an unknown {section.name} status")

    results = data.get(f"{section.name}_results")
    if results is not None:
        return _from_results(results, sent, section)
    # An envelope problem: the whole section was rejected, nothing is stored. The detail is the
    # server's own text and it is logged: printable and short only.
    detail = data.get(f"{section.name}_detail")
    return Acknowledgement(
        batch_failure=f"{section.name} section rejected"
        + (f": {safe_text(detail)}" if isinstance(detail, str) else "")
    )


def _from_results(results: object, sent: list[str], section: AckSection) -> Acknowledgement:
    if not isinstance(results, list):
        return Acknowledgement(batch_failure=f"{section.name}_results is not a list")

    sent_set = set(sent)
    outcomes: dict[str, tuple[str, str, bool]] = {}
    conflicting: set[str] = set()
    for entry in results:
        if not isinstance(entry, dict):
            continue
        measurement_id = entry.get(section.id_key)
        result = entry.get("result")
        if not isinstance(measurement_id, str) or measurement_id not in sent_set:
            continue
        if not isinstance(result, str):
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
