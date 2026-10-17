"""Builders for alerts tests."""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.utils import timezone

from apps.alerts.models import AlertRule, Incident

T0 = timezone.now().replace(microsecond=0) - timedelta(hours=1)


def at(seconds: int):
    """A moment ``seconds`` after T0."""
    return T0 + timedelta(seconds=seconds)


def ref(kind: str = "server") -> str:
    """A fresh reference of ``kind``'s form."""
    base = str(uuid.uuid4())
    if kind == "container":
        return f"{base}:3f4e5d6c7b8a"
    if kind == "interface":
        return f"{base}:12"
    return base


def make_rule(name: str = "Test rule", **fields) -> AlertRule:
    values = {"entity_kind": "server", "health": "critical", "severity": "critical", **fields}
    return AlertRule.objects.create(name=name, **values)


def open_incident(rule: AlertRule, entity_ref: str | None = None, *, site=None, label: str = "host-1", started: int = 0, opened: int = 60) -> Incident:
    return Incident.begin(
        rule=rule,
        entity_kind=rule.entity_kind,
        entity_ref=entity_ref or ref(rule.entity_kind),
        entity_label=label,
        site_id=site.pk if site is not None else None,
        started_at=at(started),
        opened_at=at(opened),
        health="critical",
        reason=rule.reason,
    )
