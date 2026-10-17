"""A small monitored estate for the engine tests, written at explicit moments.

Every time is ``t(seconds)``, seconds after a fixed instant, so a test reads as a
timeline and runs the same on any day. ``evaluate`` runs one cycle at such a
moment with the monitoring window open since long before, unless told otherwise.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from django.test import TestCase, override_settings

from apps.agents.models import Agent
from apps.agents.services import create_agent
from apps.alerts import engine
from apps.alerts.models import AlertRule, Incident
from apps.infrastructure.models import DockerContainer, DockerHostState, Server, ServerTelemetry
from apps.inventory.models import Customer, Device, Site
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.snmp.models import DeviceSnmpState, Interface, SnmpConfig

T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)


def t(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


# The console's defaults, pinned so the environment the tests run in cannot change them.
PINNED = override_settings(
    SENTINEL_OFFLINE_THRESHOLD=90,
    SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT=80,
    SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT=95,
    SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS=150,
    SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT=2,
    SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES=3,
)


def evaluate(at: float, *, since: float | None = -86_400) -> engine.Report:
    """One cycle at ``t(at)``; the monitoring window open since ``t(since)`` (None: the ingest is down)."""
    return engine.evaluate(t(at), monitoring_since=None if since is None else t(since))


class Fleet:
    """Customers, sites, and builders for what the agents report."""

    def __init__(self) -> None:
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.dc = Site.objects.create(customer=self.acme, name="DC")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")

    # -- servers ---------------------------------------------------------------

    def server(self, name: str, *, site: Site | None = None, seen: float | None = 0, cpu: float = 10.0) -> Server:
        """A server with an agent, its last heartbeat (and resource reading) at ``t(seen)``."""
        server = Server.objects.create(name=name, hostname=f"{name}.internal", site=site)
        create_agent(server=server, name=f"{name}-agent")
        if seen is not None:
            self.heartbeat(server, seen, cpu=cpu)
        return server

    def heartbeat(self, server: Server, at: float, *, cpu: float | None = 10.0) -> None:
        """A heartbeat at ``t(at)``, with a resource reading unless ``cpu`` is None."""
        Server.objects.filter(pk=server.pk).update(last_seen_at=t(at), status=Server.Status.ONLINE)
        Agent.objects.filter(server=server).update(last_seen_at=t(at))
        if cpu is not None:
            gib = 1024**3
            ServerTelemetry.objects.update_or_create(
                server=server,
                defaults={
                    "cpu_percent": cpu,
                    "memory_total_bytes": 16 * gib,
                    "memory_used_bytes": 4 * gib,
                    "memory_percent": 25.0,
                    "disk_total_bytes": 500 * gib,
                    "disk_used_bytes": 100 * gib,
                    "disk_percent": 20.0,
                    "uptime_seconds": 86_400,
                    "collected_at": t(at),
                    "received_at": t(at),
                },
            )

    def move(self, obj, site: Site | None) -> None:
        type(obj).objects.filter(pk=obj.pk).update(site=site)

    # -- Docker ----------------------------------------------------------------

    def docker(self, server: Server, at: float, *, available: bool = True) -> None:
        DockerHostState.objects.update_or_create(
            server=server,
            defaults={
                "available": available,
                "status": DockerHostState.Status.AVAILABLE if available else DockerHostState.Status.UNAVAILABLE,
                "collected_at": t(at),
                "received_at": t(at),
                "last_discovered_at": t(at) if available else None,
            },
        )

    def container(self, server: Server, name: str, *, state: str = "running", health: str = "none", at: float = 0) -> DockerContainer:
        return DockerContainer.objects.create(
            server=server,
            container_id=uuid.uuid4().hex,
            name=name,
            image="example/app:1",
            state=state,
            health=health,
            present=True,
            last_seen_at=t(at),
            received_at=t(at),
        )

    def set_container(self, container: DockerContainer, at: float, **fields) -> None:
        DockerContainer.objects.filter(pk=container.pk).update(received_at=t(at), last_seen_at=t(at), **fields)

    # -- network targets -------------------------------------------------------

    def target(self, name: str, server: Server, *, site: Site | None = None, interval: int = 60) -> NetworkTarget:
        return NetworkTarget.objects.create(
            name=name,
            hostname_or_ip="192.0.2.20",
            protocol=NetworkTarget.Protocol.ICMP,
            monitoring_interval_seconds=interval,
            site=site,
            assigned_agent=server.agent,
        )

    def measure(self, target: NetworkTarget, at: float, *, success: bool = True, latency: float = 12.0) -> None:
        NetworkMeasurement.objects.create(
            id=uuid.uuid4(),
            target=target,
            agent=target.assigned_agent,
            measured_at=t(at),
            received_at=t(at),
            success=success,
            latency_ms=latency if success else None,
            packet_loss_percentage=0.0 if success else 100.0,
            probe_count=4,
            successful_probes=4 if success else 0,
            failure_reason="" if success else NetworkMeasurement.FailureReason.TIMEOUT,
        )

    # -- SNMP ------------------------------------------------------------------

    def device(self, name: str, server: Server, *, site: Site | None = None, interval: int = 300) -> Device:
        device = Device.objects.create(name=name, management_address="192.0.2.30", site=site, assigned_agent=server.agent)
        SnmpConfig.objects.create(device=device, credential_profile="core", poll_interval_seconds=interval)
        return device

    def poll(self, device: Device, at: float, *, reachable: bool = True) -> None:
        DeviceSnmpState.objects.update_or_create(
            device=device,
            defaults={
                "last_poll_at": t(at),
                "received_at": t(at),
                "reachable": reachable,
                "last_success_at": t(at) if reachable else None,
                "error": "" if reachable else "timeout",
            },
        )

    def interface(self, device: Device, if_index: int, *, admin: int = 1, oper: int = 1) -> Interface:
        return Interface.objects.create(device=device, if_index=if_index, name=f"Gi0/{if_index}", admin_status=admin, oper_status=oper)


def rule(key: str) -> AlertRule:
    return AlertRule.objects.get(key=key)


def incidents(**filters) -> list[Incident]:
    return list(Incident.objects.filter(**filters).order_by("opened_at", "pk"))


@PINNED
class EngineTestCase(TestCase):
    """Only the rules a test turns on are enabled (the defaults are, until then, off)."""

    def setUp(self) -> None:
        AlertRule.objects.update(enabled=False)
        self.fleet = Fleet()

    def enable(self, key: str, **changes) -> AlertRule:
        found = rule(key)
        found.enabled = True
        for name, value in changes.items():
            setattr(found, name, value)
        found.save()
        return found

    def kinds(self, incident: Incident) -> list[str]:
        return list(incident.events.order_by("at", "pk").values_list("kind", flat=True))
