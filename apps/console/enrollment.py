"""Adding monitored hosts from the console: ``POST /servers/``, ``POST /servers/<id>/agents/``,
``POST /agents/<id>/rotate-token/`` and ``PATCH /agents/<id>/``.

Who: every write needs what changing alert rules needs (``alerts.change_alertrule`` and
global visibility) and the model permission the admin asks for the same action
(``infrastructure.add_server``, ``agents.add_agent``, ``agents.change_agent``; see
``apps.console.permissions``); otherwise 403. The admin and ``manage.py create_agent`` remain
possible: all three make and rotate tokens with the same code (``apps.agents.services``: a
256-bit random token, of which only a peppered HMAC-SHA256 is stored).

Server, the body of ``POST /servers/`` (``name`` required; anything else optional)::

    {"name": str, "hostname": str (the name when omitted or blank), "description": str (""),
     "operatingSystem": str (""), "ipAddress": str | null (null),
     "siteId": str | null (null: no site, visible only to accounts that see every customer)}

201 with ``Location`` and the server's detail (``GET /servers/<id>/``, ``apps.console.servers``),
whose ``agent`` is null until one is added. A name another server has is a 409
``server_exists``; invalid values are a 400 ``validation_error`` with ``fields`` (unknown fields
are refused there too); the body is at most 16 KiB. No text may hold a control character (the
description keeps its line breaks); the name is stored in Unicode NFC, so two spellings of one
name are one server; a hostname, when given, is a host name (RFC 1123: labels of letters, digits
and hyphens joined by dots) or an IP address.

Agent, ``POST /servers/<id>/agents/`` with ``{"name": str}`` (optional: the server's name)::

    {"generatedAt", "item": Agent, "token": str, "serverUrl": str | null}

``token`` is the plaintext token, in this one answer and never again: it is not stored (only
its hash is), not logged, and not in any later answer; the answer is ``Cache-Control: no-store``
as every console answer is. ``serverUrl`` is the address the agent must send its heartbeats to:
``SENTINEL_URL``, and null while it is not set (the address this request came to is a guess that
is wrong behind TLS, so only ``DEBUG`` answers it). A server that has an agent already is a 409
``agent_exists``; an unknown server a 404.

Agent::

    {"id", "name", "enabled": bool, "lastSeenAt": str | null, "agentVersion": str,
     "createdAt", "updatedAt"}

Rotation, ``POST /agents/<id>/rotate-token/`` with no body (or ``{}``): the same answer as the
creation, with the new token. The old token stops working at once: the host's agent fails
until it has the new one.

Change, ``PATCH /agents/<id>/`` with ``{"enabled": bool}``: 200 ``{"generatedAt", "item": Agent}``.
A disabled agent is refused by the heartbeat endpoint exactly as an unknown token is; enabling it
again needs no new token. Nothing else about an agent changes here, and nothing is deleted.

Every write is logged (``apps.console``) with the account's id and the server's and agent's
ids, never the token.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from uuid import UUID

from django.conf import settings
from django.core.exceptions import NON_FIELD_ERRORS, ValidationError
from django.core.validators import validate_ipv46_address
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.utils import timezone

from apps.agents.models import Agent
from apps.agents.services import AgentAlreadyExistsError, create_agent, rotate_token
from apps.console import servers
from apps.console.http import API_PREFIX, ApiError, console_api, json_object, storable_text, validation_error
from apps.console.params import QueryParams, canonical_uuid
from apps.console.permissions import may_add_agents, may_add_servers, may_change_agents, require
from apps.console.serializers import iso
from apps.infrastructure.models import Server
from apps.inventory.models import Site

logger = logging.getLogger("apps.console")

NAME_MAX_LENGTH = Server._meta.get_field("name").max_length
HOSTNAME_MAX_LENGTH = Server._meta.get_field("hostname").max_length
OS_MAX_LENGTH = Server._meta.get_field("operating_system").max_length
DESCRIPTION_MAX_LENGTH = 2000
AGENT_NAME_MAX_LENGTH = Agent._meta.get_field("name").max_length
# The longest name, hostname, operating system and description, each character escaped as JSON may (\uXXXX).
MAX_SERVER_BODY_BYTES = 16 * 1024
MAX_AGENT_BODY_BYTES = 4096
SERVER_FIELDS = ("name", "hostname", "description", "operatingSystem", "ipAddress", "siteId")
# Model field (as validation errors name it) -> body field.
ERROR_FIELDS = {
    "name": "name",
    "hostname": "hostname",
    "description": "description",
    "operating_system": "operatingSystem",
    "ip_address": "ipAddress",
    "site": "siteId",
    NON_FIELD_ERRORS: "nonField",
}
NAME_TAKEN = "A server with this name already exists."
NOT_PERMITTED = "This account may not add or change monitored hosts."
# RFC 1123: a label is letters, digits and hyphens, neither first nor last a hyphen, at most 63 long;
# the whole name (labels joined by dots) at most 253.
HOSTNAME_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\Z")
DNS_NAME_MAX_LENGTH = 253
NOT_A_HOSTNAME = "Expected a host name (letters, digits, hyphens and dots) or an IP address."


def _controls(value: str, *, allowed: str = "") -> bool:
    """Whether ``value`` holds a control character (Unicode category Cc) other than those ``allowed``."""
    return any(unicodedata.category(char) == "Cc" and char not in allowed for char in value)


def _text(data: dict, name: str, *, limit: int, errors: dict, multiline: bool = False) -> str:
    """The text of an optional field ("" when absent), with what is wrong with it in ``errors``.

    Control characters are refused, as ``apps.console.params`` refuses them in a search: a line
    break or an escape sequence in a name would end up in an email or a log line. A multi-line
    field keeps its tabs and line breaks; the others are stripped by the caller, so what is
    stripped away is not held against them.
    """
    value = data.get(name, "")
    if not isinstance(value, str):
        errors[name] = ["Expected text."]
        return ""
    if not storable_text(value):
        errors[name] = ["This text cannot be stored."]
        return ""
    if len(value) > limit:
        errors[name] = [f"At most {limit} characters."]
        return ""
    if _controls(value if multiline else value.strip(), allowed="\t\n\r" if multiline else ""):
        errors[name] = ["Control characters are not allowed."]
        return ""
    return value


def host_name(value: str) -> bool:
    """Whether ``value`` is a host name (RFC 1123) or an IPv4 or IPv6 address."""
    if len(value) <= DNS_NAME_MAX_LENGTH and all(HOSTNAME_LABEL.match(label) for label in value.split(".")):
        return True
    try:
        validate_ipv46_address(value)
    except ValidationError:
        return False
    return True


def parse_server(data: dict) -> dict:
    """The model values of a ``POST /servers/`` body, or a 400 with what is wrong, field by field."""
    errors: dict[str, list[str]] = {}
    for name in sorted(set(data) - set(SERVER_FIELDS)):
        errors[name] = ["Unknown field."]
    # One spelling per name (NFC), so that a composed and a decomposed "é" cannot be two servers.
    name = unicodedata.normalize("NFC", _text(data, "name", limit=NAME_MAX_LENGTH, errors=errors).strip())
    if "name" not in errors and not name:
        errors["name"] = ["Required."]
    hostname = _text(data, "hostname", limit=HOSTNAME_MAX_LENGTH, errors=errors).strip()
    if "hostname" not in errors and hostname and not host_name(hostname):
        errors["hostname"] = [NOT_A_HOSTNAME]
    values = {
        "name": name,
        "hostname": hostname or name,  # as the model stores it: a host is named by its name unless told otherwise
        "description": _text(data, "description", limit=DESCRIPTION_MAX_LENGTH, errors=errors, multiline=True),
        "operating_system": _text(data, "operatingSystem", limit=OS_MAX_LENGTH, errors=errors).strip(),
        "ip_address": None,
        "site_id": None,
    }
    address = data.get("ipAddress")
    if address is not None:
        address = _text(data, "ipAddress", limit=64, errors=errors).strip()
        if "ipAddress" not in errors and address:
            try:
                validate_ipv46_address(address)
            except ValidationError:
                errors["ipAddress"] = ["Expected an IPv4 or IPv6 address."]
            else:
                values["ip_address"] = address
    site_id = data.get("siteId")
    if site_id is not None:
        parsed = canonical_uuid(site_id)
        if parsed is None:
            errors["siteId"] = ["Expected the id of a site."]
        elif not Site.objects.filter(pk=parsed).exists():
            errors["siteId"] = ["No such site."]
        else:
            values["site_id"] = parsed
    if errors:
        raise validation_error(errors)
    return values


def model_errors(error: ValidationError) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    for model_field, messages in error.message_dict.items():
        name = ERROR_FIELDS.get(model_field, "nonField")
        for message in messages:
            if message not in fields.setdefault(name, []):
                fields[name].append(message)
    return fields


def name_taken(error: ValidationError) -> bool:
    return any(problem.code == "unique" for problem in getattr(error, "error_dict", {}).get("name", []))


def server_url(request) -> str | None:
    """The address the agent must use: ``SENTINEL_URL``, or none while it is not set.

    The address this request came to is only a guess (``http://`` behind a proxy that ends TLS, a
    development proxy's port): it is answered with ``DEBUG`` on, and never in production, where the
    console says to set ``SENTINEL_URL`` instead of showing commands with a wrong address.
    """
    if settings.SENTINEL_URL:
        return settings.SENTINEL_URL
    if settings.DEBUG:
        return request.build_absolute_uri("/").rstrip("/")
    return None


def token_answer(request, now, agent: Agent, raw_token: str, *, status: int = 200) -> JsonResponse:
    """The one answer that carries a plaintext token (``console_api`` makes it ``no-store``)."""
    payload = {
        "generatedAt": iso(now),
        "item": servers.agent_of(agent.server_id),
        "token": raw_token,
        "serverUrl": server_url(request),
    }
    return JsonResponse(payload, status=status)


@console_api(methods=("GET", "POST"))
def server_collection(request):
    if request.method == "POST":
        return create_server(request)
    return servers.server_list(request)


def create_server(request):
    now = timezone.now()
    user = request.user
    require(may_add_servers(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    server = Server(**parse_server(json_object(request, max_bytes=MAX_SERVER_BODY_BYTES)))
    try:
        with transaction.atomic():
            server.full_clean()  # the model's own checks (the address, the site, the unique name) in one place
            server.save(force_insert=True)
    except ValidationError as error:
        if name_taken(error):
            raise ApiError(409, "server_exists", NAME_TAKEN) from None
        raise validation_error(model_errors(error)) from None
    except IntegrityError as error:
        # The name taken by a server saved meanwhile; anything else is not a conflict to explain.
        constraint = getattr(getattr(error.__cause__, "diag", None), "constraint_name", None) or ""
        if not constraint.endswith("_name_key"):
            raise
        raise ApiError(409, "server_exists", NAME_TAKEN) from None
    logger.info("Server created (server=%s, site=%s, user_id=%s)", server.pk, server.site_id, user.pk)
    response = JsonResponse(servers.detail_payload(request.visibility, server.pk, now), status=201)
    response["Location"] = f"{request.path}{server.pk}/"
    return response


@console_api(methods=("POST",))
def agent_collection(request, server_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_add_agents(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    data = json_object(request, max_bytes=MAX_AGENT_BODY_BYTES, empty=True)
    errors: dict[str, list[str]] = {}
    for name in sorted(set(data) - {"name"}):
        errors[name] = ["Unknown field."]
    name = _text(data, "name", limit=AGENT_NAME_MAX_LENGTH, errors=errors).strip()
    if errors:
        raise validation_error(errors)
    with transaction.atomic():
        # One agent per server: the row is held, so two additions at once see each other.
        server = request.visibility.get(Server.objects.select_for_update(no_key=True), server_id)
        try:
            agent, raw_token = create_agent(server=server, name=name or server.name)
        except AgentAlreadyExistsError:
            raise ApiError(409, "agent_exists", "This server already has an agent.") from None
        # The answer is built before the commit: an agent whose token could not be answered is not kept.
        response = token_answer(request, now, agent, raw_token, status=201)
    logger.info("Agent created (agent=%s, server=%s, user_id=%s)", agent.pk, server.pk, user.pk)
    response["Location"] = f"{API_PREFIX}agents/{agent.pk}/"
    return response


def visible_agent(request, agent_id: UUID) -> Agent:
    """The agent, its row held until the end of the transaction; 404 when unknown or on a hidden server."""
    return request.visibility.get(Agent.objects.select_for_update(no_key=True), agent_id, site_path="server__site")


@console_api(methods=("POST",))
def rotate_agent_token(request, agent_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_change_agents(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    data = json_object(request, max_bytes=MAX_AGENT_BODY_BYTES, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: a rotation has no options."] for name in sorted(data)})
    with transaction.atomic():
        agent = visible_agent(request, agent_id)
        raw_token = rotate_token(agent)
    logger.info("Agent token rotated (agent=%s, server=%s, user_id=%s)", agent.pk, agent.server_id, user.pk)
    return token_answer(request, now, agent, raw_token)


@console_api(methods=("PATCH",))
def agent_item(request, agent_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_change_agents(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    data = json_object(request, max_bytes=MAX_AGENT_BODY_BYTES)
    errors: dict[str, list[str]] = {}
    for name in sorted(set(data) - {"enabled"}):
        errors[name] = ["Unknown field."]
    enabled = data.get("enabled")
    if not isinstance(enabled, bool):
        errors["enabled"] = ["Required: true or false."]
    if errors:
        raise validation_error(errors)
    with transaction.atomic():
        agent = visible_agent(request, agent_id)
        if agent.enabled != enabled:
            agent.enabled = enabled
            agent.save(update_fields=["enabled", "updated_at"])
            logger.info(
                "Agent %s (agent=%s, server=%s, user_id=%s)",
                "enabled" if enabled else "disabled",
                agent.pk,
                agent.server_id,
                user.pk,
            )
    return JsonResponse({"generatedAt": iso(now), "item": servers.agent_of(agent.server_id)})
