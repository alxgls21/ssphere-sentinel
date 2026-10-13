"""Builders for console tests."""

from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from unittest.mock import patch

from apps.console.http import CONSOLE_SESSION_KEY
from apps.console.models import CustomerAccess, SiteAccess
from apps.infrastructure.models import DockerContainer, DockerHostState, Server, ServerTelemetry
from apps.inventory.models import Customer, Device, Site

PASSWORD = "correct-horse-battery-staple-42"
CONTRACT_DIR = Path(__file__).parent / "contract"


def permission(codename: str) -> Permission:
    return Permission.objects.get(content_type__app_label="console", codename=codename)


def make_user(
    username: str = "viewer",
    *,
    console: bool = True,
    all_customers: bool = False,
    superuser: bool = False,
    active: bool = True,
    customers=(),
    sites=(),
    password: str = PASSWORD,
    **extra,
):
    User = get_user_model()
    if superuser:
        user = User.objects.create_superuser(username, password=password, is_active=active, **extra)
    else:
        user = User.objects.create_user(username, password=password, is_active=active, **extra)
    if console:
        user.user_permissions.add(permission("use_console"))
    if all_customers:
        user.user_permissions.add(permission("view_all_customers"))
    for customer in customers:
        CustomerAccess.objects.create(user=user, customer=customer)
    for site in sites:
        SiteAccess.objects.create(user=user, site=site)
    return user


class Org:
    """Three customers; two with sites; devices (the one model with a site today) in each."""

    def __init__(self) -> None:
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.empty = Customer.objects.create(name="Empty Corp")
        self.acme_hq = Site.objects.create(customer=self.acme, name="HQ")
        self.acme_dc = Site.objects.create(customer=self.acme, name="DC")
        self.globex_plant = Site.objects.create(customer=self.globex, name="Plant")
        self.dev_hq = self.device("acme-hq-sw", self.acme_hq)
        self.dev_dc = self.device("acme-dc-sw", self.acme_dc)
        self.dev_plant = self.device("globex-plant-sw", self.globex_plant)
        self.dev_free = self.device("unassigned-sw", None)

    @staticmethod
    def device(name, site):
        return Device.objects.create(name=name, management_address="192.0.2.1", site=site)

    @property
    def devices(self):
        return [self.dev_hq, self.dev_dc, self.dev_plant, self.dev_free]


def start_console_session(client: Client, user, *, signed_in_at: int | None = None) -> Client:
    """Log ``client`` in as ``user`` with a *console* session (what the sign-in endpoint creates)."""
    client.force_login(user)
    session = client.session
    session[CONSOLE_SESSION_KEY] = int(time.time()) if signed_in_at is None else signed_in_at
    session.save()
    return client


def signed_in_client(user, *, enforce_csrf: bool = False) -> Client:
    client = Client(enforce_csrf_checks=enforce_csrf, raise_request_exception=False)
    return start_console_session(client, user)


def load_contract(name: str):
    return json.loads((CONTRACT_DIR / name).read_text(encoding="utf-8"))


def new_uuid() -> uuid.UUID:
    return uuid.uuid4()


# -- servers and containers ---------------------------------------------------


def make_server(
    name: str,
    *,
    site: Site | None = None,
    now: datetime,
    seen_ago: float | None = 5,
    stored_status: str = Server.Status.ONLINE,
    cpu: float | None = 10.0,
    memory: float = 20.0,
    disk: float = 30.0,
    uptime: int = 86_400,
    telemetry_ago: float | None = None,
    **extra,
) -> Server:
    """A server last seen ``seen_ago`` seconds before ``now`` (``None``: never), with telemetry unless ``cpu`` is ``None``.

    The telemetry arrived ``telemetry_ago`` seconds before ``now``; by default together with the last heartbeat.
    """
    server = Server.objects.create(
        name=name,
        hostname=extra.pop("hostname", f"{name}.internal"),
        site=site,
        status=stored_status,
        last_seen_at=None if seen_ago is None else now - timedelta(seconds=seen_ago),
        **extra,
    )
    if cpu is not None:
        reported_ago = telemetry_ago if telemetry_ago is not None else (seen_ago or 0)
        gib = 1024**3
        ServerTelemetry.objects.create(
            server=server,
            cpu_percent=cpu,
            memory_total_bytes=16 * gib,
            memory_used_bytes=int(16 * gib * memory / 100),
            memory_percent=memory,
            disk_total_bytes=500 * gib,
            disk_used_bytes=int(500 * gib * disk / 100),
            disk_percent=disk,
            uptime_seconds=uptime,
            collected_at=now - timedelta(seconds=reported_ago),
            received_at=now - timedelta(seconds=reported_ago),
        )
    return server


def make_docker_host(
    server: Server, *, now: datetime, available: bool = True, received_ago: float = 0
) -> DockerHostState:
    """The Docker state of ``server``, whose last report arrived ``received_ago`` seconds before ``now``."""
    received = now - timedelta(seconds=received_ago)
    return DockerHostState.objects.create(
        server=server,
        available=available,
        status=DockerHostState.Status.AVAILABLE if available else DockerHostState.Status.UNAVAILABLE,
        collected_at=received,
        received_at=received,
        last_discovered_at=received if available else None,
    )


def make_container(
    server: Server,
    name: str,
    *,
    now: datetime,
    state: str = DockerContainer.State.RUNNING,
    health: str = DockerContainer.Health.NONE,
    present: bool = True,
    image: str = "nginx:1.27",
    container_id: str | None = None,
    started_ago: float | None = 3600,
) -> DockerContainer:
    return DockerContainer.objects.create(
        server=server,
        container_id=container_id or uuid.uuid4().hex + uuid.uuid4().hex,
        name=name,
        image=image,
        state=state,
        health=health,
        present=present,
        started_at=None if started_ago is None else now - timedelta(seconds=started_ago),
        last_seen_at=now,
        received_at=now,
    )


API = "/api/v1/console/"

# Pinned, so the tests do not depend on SENTINEL_* values in the environment they run in.
PINNED = override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    SENTINEL_OFFLINE_THRESHOLD=90,
    SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT=80,
    SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT=95,
    SECURE_SSL_REDIRECT=False,  # an environment that enables the redirect would answer 301 to every request
)


def fixed(suffix: str) -> uuid.UUID:
    return uuid.UUID(f"00000000-0000-0000-0000-{suffix:0>12}")


@PINNED
class ConsoleDataTestCase(TestCase):
    """A test case whose clock stands still: ``self.now`` is "now" for the code under test as well."""

    def setUp(self):
        super().setUp()
        self.now = timezone.now()
        patcher = patch("django.utils.timezone.now", return_value=self.now)
        patcher.start()
        self.addCleanup(patcher.stop)

    def get(self, user, path: str, **params):
        return signed_in_client(user).get(API + path, params)

    def names(self, response) -> list[str]:
        self.assertEqual(response.status_code, 200, response.content[:300])
        return [item["server"]["name"] for item in response.json()["items"]]
