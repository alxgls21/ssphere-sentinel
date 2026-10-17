"""Response bodies. Keys are camelCase and match the UI's ``api/types.ts``."""

from __future__ import annotations

from datetime import datetime, timezone as dt_timezone
from uuid import UUID

from django.middleware.csrf import get_token
from django.utils import timezone

from apps.console.access import Visibility
from apps.console.health import offline_cutoff
from apps.console.thresholds import thresholds
from apps.infrastructure.models import Server

API_VERSION = 1


def iso(value: datetime) -> str:
    """ISO-8601 UTC with a ``Z`` suffix, as the UI expects."""
    return value.astimezone(dt_timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def agent_server_names(visibility: Visibility, rows: list[dict]) -> dict[UUID, str]:
    """Visible names for a page's assigned-agent servers, in one query."""
    server_ids = {row["assigned_agent__server_id"] for row in rows if row["assigned_agent__server_id"] is not None}
    if not server_ids:
        return {}
    return dict(visibility.filter(Server.objects.filter(pk__in=server_ids)).values_list("pk", "name"))


def assigned_agent_payload(row: dict, servers: dict[UUID, str], now: datetime) -> dict | None:
    """The shared target/device agent shape, hidden unless its server is visible."""
    server_id = row["assigned_agent__server_id"]
    if row["assigned_agent_id"] is None or server_id not in servers:
        return None
    last_seen = row["assigned_agent__last_seen_at"]
    if last_seen is None:
        status = "unknown"
    else:
        status = "online" if last_seen >= offline_cutoff(now) else "offline"
    return {
        "id": str(row["assigned_agent_id"]),
        "name": row["assigned_agent__name"],
        "status": status,
        "lastSeenAt": iso(last_seen) if last_seen else None,
        "serverId": str(server_id),
        "serverName": servers[server_id],
    }


def session_payload(request, user=None, *, reason: str | None = None) -> dict:
    """Who is signed in (nothing for an anonymous caller) and the CSRF token for POSTs."""
    payload: dict = {
        "apiVersion": API_VERSION,
        "serverTime": iso(timezone.now()),
        "authenticated": user is not None,
        "reason": reason,
        "csrfToken": get_token(request),
        "user": None,
        "access": None,
        "thresholds": None,
    }
    if user is not None:
        visibility = Visibility.for_user(user)
        payload["user"] = {
            "username": user.get_username(),
            "displayName": user.get_full_name() or user.get_username(),
        }
        payload["access"] = {"allCustomers": visibility.all_access}
        payload["thresholds"] = thresholds()
    return payload


def scope_payload(visibility: Visibility) -> dict:
    """``ScopeOptions``: the customers and sites the user may filter by.

    Sorted here, case-insensitively, rather than by the database: collations
    differ between PostgreSQL installations and the order must not.
    """
    customers = sorted(
        (
            {"id": str(pk), "name": name}
            for pk, name in visibility.customers().values_list("pk", "name")
        ),
        key=lambda c: (c["name"].casefold(), c["name"], c["id"]),
    )
    rows = visibility.sites().values_list("pk", "customer_id", "name", "customer__name")
    sites = [
        {"id": str(pk), "customerId": str(customer_id), "name": name}
        for pk, customer_id, name, _customer_name in sorted(
            rows, key=lambda r: (r[3].casefold(), r[3], r[2].casefold(), r[2], str(r[0]))
        )
    ]
    return {"customers": customers, "sites": sites}
