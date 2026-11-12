"""Network targets from the console: ``POST /targets/``, ``PATCH`` and ``DELETE /targets/<id>/``
(reading them is ``apps.console.targets``, which answers the GET of the same URLs).

Who: what configuring monitoring needs (``alerts.change_alertrule`` with global visibility) and
the admin's model permission for the action (``network.add_networktarget``,
``change_networktarget``, ``delete_networktarget``); otherwise 403. A hidden or unknown target
is a 404. See ``apps.console.permissions``.

The body of ``POST /targets/`` (``name``, ``address`` and ``protocol`` required)::

    {"name": str, "address": str (a host name or an IP address), "protocol": icmp | tcp,
     "port": int | null (null; a TCP target needs one, an ICMP target must not have one),
     "enabled": bool (true), "intervalSeconds": int (60; 10-86400), "timeoutSeconds": int (2; 1-30),
     "expectedSlaPercent": number (99.9; 0-100, two decimals), "customerLabel": str ("", a free-text
     label for reports: access control never looks at it, the site decides who sees the target),
     "circuitId": str (""), "siteId": str | null (null: seen by accounts with every customer only),
     "agentId": str | null (null: nothing measures it; the agent of a server the user may see)}

The model validates the rest (``apps.network.models``: the bounds, the port against the
protocol, the site and the agent); ``address`` is checked as a server's hostname is
(``apps.console.enrollment``), since the agent refuses anything else. Invalid values are a 400
``validation_error`` with ``fields`` (unknown fields are refused there too); the body is at most
8 KiB. 201 with ``Location`` and the target's detail (``GET /targets/<id>/``), whose ``agentEntry``
is the line to add to the agent's targets file.

Change: ``PATCH`` with any of the fields; only those sent change. 200 with the detail; nothing
to change answers it as it is. Enabling or disabling is ``{"enabled": bool}``.

Delete: ``DELETE`` with no body: the target goes with its measurement history (which can be
large: the request takes as long as that takes); an incident of the target ends at the alert
engine's next cycle. 200 ``{"generatedAt", "deleted": {"id", "name", "measurements": int}}``.

Every write is logged (``apps.console``) and recorded in the audit trail (``apps.console.audit``).
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from uuid import UUID

from django.core.exceptions import NON_FIELD_ERRORS, ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone

from apps.console import audit, targets
from apps.console.enrollment import NOT_A_HOSTNAME, host_name
from apps.console.fields import boolean, choice, integer, model_errors, reference, text, unknown_fields
from apps.console.http import console_api, json_object, validation_error
from apps.console.params import QueryParams, canonical_uuid
from apps.console.permissions import may_add_targets, may_change_targets, may_delete_targets, require
from apps.console.serializers import iso
from apps.infrastructure.models import Server
from apps.inventory.models import Site
from apps.network.models import NetworkMeasurement, NetworkTarget

logger = logging.getLogger("apps.console")

NAME_MAX_LENGTH = NetworkTarget._meta.get_field("name").max_length
ADDRESS_MAX_LENGTH = NetworkTarget._meta.get_field("hostname_or_ip").max_length
TEXT_MAX_LENGTH = NetworkTarget._meta.get_field("customer_name").max_length
MAX_BODY_BYTES = 8 * 1024
NOT_PERMITTED = "This account may not add or change network targets."
PROTOCOLS = tuple(NetworkTarget.Protocol.values)
# Body field -> model field.
BODY_FIELDS = {
    "name": "name",
    "address": "hostname_or_ip",
    "protocol": "protocol",
    "port": "port",
    "enabled": "enabled",
    "intervalSeconds": "monitoring_interval_seconds",
    "timeoutSeconds": "timeout_seconds",
    "expectedSlaPercent": "expected_sla_percentage",
    "customerLabel": "customer_name",
    "circuitId": "circuit_identifier",
    "siteId": "site_id",
    "agentId": "assigned_agent_id",
}
REQUIRED_ON_CREATE = ("name", "address", "protocol")
# Model field (as validation errors name it) -> body field.
ERROR_FIELDS = {
    **{model: body for body, model in BODY_FIELDS.items()},
    "site": "siteId",
    "assigned_agent": "agentId",
    NON_FIELD_ERRORS: "nonField",
}


def visible_agent_id(visibility, data: dict, errors: dict) -> UUID | None:
    """The id of an agent on a server the user may see, null for none; a hidden one is not found."""
    value = data.get("agentId")
    if value is None:
        return None
    parsed = canonical_uuid(value)
    if parsed is None:
        errors["agentId"] = ["Expected the id of an agent."]
        return None
    # Through the server it runs on (the one the user must see), never the agents app itself.
    if not visibility.filter(Server.objects.filter(agent__pk=parsed)).exists():
        errors["agentId"] = ["No such agent."]
        return None
    return parsed


def parse_target(visibility, data: dict, *, creating: bool) -> dict:
    """The model values a body sets, or a 400 with what is wrong, field by field."""
    errors: dict[str, list[str]] = {}
    unknown_fields(data, BODY_FIELDS, errors)
    if creating:
        for name in REQUIRED_ON_CREATE:
            if name not in data:
                errors[name] = ["Required."]
    values: dict = {}
    for name in data:
        if name not in BODY_FIELDS:
            continue
        model_field = BODY_FIELDS[name]
        if name == "name":
            parsed = text(data, name, limit=NAME_MAX_LENGTH, errors=errors).strip()
            if name not in errors and not parsed:
                errors[name] = ["Required."]
        elif name == "address":
            parsed = text(data, name, limit=ADDRESS_MAX_LENGTH, errors=errors).strip()
            if name not in errors and not host_name(parsed):
                errors[name] = [NOT_A_HOSTNAME]
        elif name == "protocol":
            parsed = choice(data, name, errors=errors, choices=PROTOCOLS)
        elif name == "port":
            parsed = None if data[name] is None else integer(data, name, errors=errors, minimum=1, maximum=65535)
        elif name == "enabled":
            parsed = boolean(data, name, errors=errors)
        elif name == "intervalSeconds":
            parsed = integer(data, name, errors=errors, minimum=10, maximum=86400)
        elif name == "timeoutSeconds":
            parsed = integer(data, name, errors=errors, minimum=1, maximum=30)
        elif name == "expectedSlaPercent":
            parsed = sla_percent(data[name], errors)
        elif name in ("customerLabel", "circuitId"):
            parsed = text(data, name, limit=TEXT_MAX_LENGTH, errors=errors).strip()
        elif name == "siteId":
            parsed = reference(data, name, errors=errors, model=Site, label="site")
        else:
            parsed = visible_agent_id(visibility, data, errors)
        if name not in errors:
            values[model_field] = parsed
    if errors:
        raise validation_error(errors)
    return values


def sla_percent(value, errors: dict) -> Decimal | None:
    """A share from 0 to 100 with at most two decimals, as the model stores it."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        errors["expectedSlaPercent"] = ["Expected a number from 0 to 100."]
        return None
    try:
        parsed = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        parsed = None
    if parsed is None or not parsed.is_finite() or not 0 <= parsed <= 100:
        errors["expectedSlaPercent"] = ["Expected a number from 0 to 100."]
        return None
    return parsed


def target_values(target: NetworkTarget) -> dict:
    """The target's fields by the names the API gives them, for the audit trail."""
    return {body: getattr(target, model) for body, model in BODY_FIELDS.items()}


def save(target: NetworkTarget) -> None:
    """Save (validated by the model) in a savepoint; a 400 with what is wrong, field by field."""
    try:
        with transaction.atomic():
            target.save()
    except ValidationError as error:
        raise validation_error(model_errors(error, ERROR_FIELDS)) from None


def visible_target(request, target_id: UUID) -> NetworkTarget:
    """The target, its row held until the end of the transaction; 404 when unknown or hidden."""
    return request.visibility.get(NetworkTarget.objects.select_for_update(no_key=True), target_id)


@console_api(methods=("GET", "POST"))
def target_collection(request):
    if request.method == "POST":
        return create_target(request)
    return targets.target_list(request)


@console_api(methods=("GET", "PATCH", "DELETE"))
def target_item(request, target_id: UUID):
    if request.method == "PATCH":
        return change_target(request, target_id)
    if request.method == "DELETE":
        return delete_target(request, target_id)
    return targets.target_detail(request, target_id)


def create_target(request):
    now = timezone.now()
    user = request.user
    require(may_add_targets(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values = parse_target(request.visibility, json_object(request, max_bytes=MAX_BODY_BYTES), creating=True)
    target = NetworkTarget(**values)
    with transaction.atomic():
        save(target)
        audit.record(
            user,
            action="target_created",
            target_type=audit.TARGET,
            target_id=target.pk,
            target_name=target.name,
            changed=audit.changes({}, target_values(target)),
        )
    logger.info("Network target created (target=%s, site=%s, agent=%s, user_id=%s)", target.pk, target.site_id, target.assigned_agent_id, user.pk)
    response = JsonResponse(targets.detail_payload(request.visibility, target.pk, now), status=201)
    response["Location"] = f"{request.path}{target.pk}/"
    return response


def change_target(request, target_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_change_targets(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values = parse_target(request.visibility, json_object(request, max_bytes=MAX_BODY_BYTES), creating=False)
    with transaction.atomic():
        target = visible_target(request, target_id)
        before = target_values(target)
        for field, value in values.items():
            setattr(target, field, value)
        after = target_values(target)
        if after != before:
            save(target)
            diff = audit.changes(before, after)
            common = {"target_type": audit.TARGET, "target_id": target.pk, "target_name": target.name}
            switched = diff.pop("enabled", None)
            if switched is not None:
                audit.record(user, action="target_enabled" if switched["after"] else "target_disabled", changed={"enabled": switched}, **common)
            if diff:
                audit.record(user, action="target_changed", changed=diff, **common)
            logger.info("Network target changed (target=%s, site=%s, agent=%s, user_id=%s)", target.pk, target.site_id, target.assigned_agent_id, user.pk)
    return JsonResponse(targets.detail_payload(request.visibility, target.pk, now))


def delete_target(request, target_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_delete_targets(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    data = json_object(request, max_bytes=1024, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: a deletion has no options."] for name in sorted(data)})
    with transaction.atomic():
        target = request.visibility.get(NetworkTarget.objects.select_for_update(), target_id)
        done = {
            "id": str(target.pk),
            "name": target.name,
            "measurements": NetworkMeasurement.objects.filter(target=target).count(),
        }
        audit.record(
            user,
            action="target_deleted",
            target_type=audit.TARGET,
            target_id=target.pk,
            target_name=target.name,
            changed=audit.changes(target_values(target), {}),
        )
        target.delete()
    logger.info("Network target deleted (target=%s, measurements=%s, user_id=%s)", done["id"], done["measurements"], user.pk)
    return JsonResponse({"generatedAt": iso(now), "deleted": done})
