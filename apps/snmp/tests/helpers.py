"""Builders for SNMP report payloads and the objects they refer to."""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.utils import timezone

from apps.agents.services import create_agent
from apps.infrastructure.models import Server
from apps.inventory.models import Device
from apps.snmp.models import SnmpConfig
from apps.snmp.reports import apply_snmp_report, validate_snmp_payload

RAW = {
    "in_octets": 1_000_000,
    "out_octets": 2_000_000,
    "in_errors": 1,
    "out_errors": 2,
    "in_discards": 3,
    "out_discards": 4,
}
DELTA = {
    "in_octets": 300_000,
    "out_octets": 600_000,
    "in_errors": 0,
    "out_errors": 1,
    "in_discards": 0,
    "out_discards": 2,
}


def make_agent(name="snmp-poller"):
    server = Server.objects.create(name=f"{name}-host", hostname=f"{name}.local")
    agent, token = create_agent(server=server, name=name)
    return agent, token


def make_device(agent, name="core-sw", *, configured=True, **overrides):
    values = {"name": name, "management_address": "192.0.2.10", "assigned_agent": agent}
    values.update(overrides)
    device = Device.objects.create(**values)
    if configured:
        SnmpConfig.objects.create(device=device, credential_profile="core-switches")
    return device


def minutes_ago(minutes: float) -> str:
    return (timezone.now() - timedelta(minutes=minutes)).isoformat()


def counters(state="ok", *, bits=64, interval=300.0, raw=None, delta=None):
    block = {
        "octets_bits": bits,
        "delta_state": state,
        "interval_seconds": interval,
        "raw": dict(RAW if raw is None else raw),
    }
    if state in ("ok", "speed_changed"):
        block["delta"] = dict(DELTA if delta is None else delta)
    else:
        block["delta"] = None if delta is None else delta
    return block


def interface(if_index=1, name=None, *, oper=1, admin=1, speed=1_000_000_000, with_counters=True, **overrides):
    entry = {
        "if_index": if_index,
        "name": name or f"Gi0/{if_index}",
        "descr": f"GigabitEthernet0/{if_index}",
        "alias": "",
        "if_type": 6,
        "speed_bps": speed,
        "admin_status": admin,
        "oper_status": oper,
    }
    if with_counters:
        entry["counters"] = counters()
    entry.update(overrides)
    return entry


def poll(device, interfaces=None, *, minutes=1.0, poll_id=None, reachable=True, **overrides):
    payload = {
        "poll_id": str(poll_id or uuid.uuid4()),
        "device_id": str(device.pk),
        "measured_at": minutes_ago(minutes),
        "reachable": reachable,
        "response_ms": 12.5 if reachable else None,
        "error": "" if reachable else "timeout",
        "sys_uptime_ticks": 8_123_456 if reachable else None,
        "interfaces": [interface(1), interface(2, with_counters=False)] if interfaces is None else interfaces,
    }
    if reachable:
        payload["system"] = {
            "name": "core-sw-1",
            "descr": "Cisco IOS XE Software, Version 17.9.4",
            "object_id": "1.3.6.1.4.1.9.1.2504",
        }
    else:
        payload["interfaces"] = []
        payload["sys_uptime_ticks"] = None
    payload.update(overrides)
    return payload


def report(polls):
    return {"version": 1, "polls": polls}


def ingest(agent, polls, **kwargs):
    """Validate and store ``polls`` like the heartbeat view does."""
    validated = validate_snmp_payload(report(polls), agent=agent)
    return apply_snmp_report(agent, validated, **kwargs)
