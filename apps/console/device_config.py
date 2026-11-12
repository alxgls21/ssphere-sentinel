"""Inventory devices and their SNMP configuration from the console: ``GET/POST /inventory/devices/``,
``GET/PATCH/DELETE /inventory/devices/<id>/``.

Every device of the inventory (``apps.inventory.Device``), with or without an SNMP configuration;
the SNMP monitoring view (``GET /devices/``, ``apps.console.devices``) shows the configured ones
with their polls. Who: reading needs what reading anything needs (the grants; a device without a
site is seen by accounts with every customer only; a hidden or unknown id is a 404). Writing
needs what configuring monitoring needs (``alerts.change_alertrule`` with global visibility)
and the admin's model permissions for the action: ``inventory.add_device`` (with
``snmp.add_snmpconfig``) to add, ``inventory.change_device`` (with the three on ``snmp.SnmpConfig``)
to change, ``inventory.delete_device`` (with ``snmp.delete_snmpconfig``) to delete; otherwise 403.

Device::

    {"id", "name", "type": router | switch | firewall | other, "address", "enabled", "description",
     "siteId": str | null, "customerName"?, "siteName"?, "agentAssigned": bool, "agent": Agent | null,
     "snmp": {"version": 2c | 3, "port", "pollIntervalSeconds", "timeoutSeconds", "retries"} | null,
     "hasHistory": bool, "createdAt", "updatedAt"}

``agent`` is as the targets give it (``{id, name, status, lastSeenAt, serverId, serverName}``,
only where its server is visible). ``snmp`` never carries the credential profile: it is the name
of a profile in the agent's own credentials file, written here and never read back, logged or
recorded. ``hasHistory``: polls or interface samples exist, so the device cannot be deleted.

List: ``{"generatedAt", "items", "page": {number, size, total, pages}, "scopeTotal"}`` with
``customer``, ``site`` (ids from ``/scope/``; unknown or hidden: 404), ``q`` (words, every one in
the name, address, description, site or customer name), ``snmp`` (all | configured | none),
``sort`` (name | type | address | created), ``dir``, ``page`` and ``pageSize``. The detail is
``{"generatedAt", "item": Device}``.

The body of ``POST`` (``name`` and ``address`` required)::

    {"name": str, "type": str (other), "address": str (a host name or a unicast IP address),
     "enabled": bool (true), "description": str (""), "siteId": str | null (null),
     "agentId": str | null (null: the agent of a server the user may see),
     "snmp": null (not polled) | {"version": 2c | 3 (3), "port": int (161), "credentialProfile": str
     (required: letters, digits, '.', '_' and '-'), "pollIntervalSeconds": int (300; 30-86400),
     "timeoutSeconds": int (5; 1-60), "retries": int (1; 0-5)}}

The models validate the rest (``apps.inventory.models``, ``apps.snmp.models``: the address, the
unique name per site, the bounds, timeout × (retries + 1) under the poll interval). Invalid
values are a 400 ``validation_error`` with ``fields``, the SNMP ones as ``snmp.<field>``
(unknown fields are refused there too); a name another device of the site has is a 409
``device_exists``; the body is at most 16 KiB. 201 with ``Location`` and the detail.

Change: ``PATCH`` with any of the fields; only those sent change. ``snmp`` sent as an object
creates the configuration or changes the keys it holds (``credentialProfile`` may be left out
to keep the one the device has); ``snmp: null`` removes it (the device is no longer polled; its
history stays). 200 with the detail; nothing to change answers it as it is.

Delete: ``DELETE`` with no body. Refused, 409 ``device_has_history``, while the device has polls
or interface samples (as the admin refuses it): disable it, and delete it after
``purge_snmp_data`` has removed the history. Otherwise the device goes with its SNMP
configuration, state and interfaces. 200 ``{"generatedAt", "deleted": {"id", "name"}}``.

Every write is logged (``apps.console``) and recorded in the audit trail (``apps.console.audit``):
a changed credential profile as ``credentialProfileChanged``, never its name.
"""

from __future__ import annotations

import logging
from datetime import datetime
from uuid import UUID

from django.core.exceptions import NON_FIELD_ERRORS, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Exists, F, OuterRef
from django.http import JsonResponse
from django.utils import timezone

from apps.console import audit
from apps.console.access import Scope, Visibility
from apps.console.fields import boolean, choice, integer, model_errors, reference, text, unknown_fields
from apps.console.http import ApiError, console_api, json_object, validation_error
from apps.console.listing import apply_search, name_order
from apps.console.params import PAGE_PARAMS, SCOPE_PARAMS, PageRequest, QueryParams
from apps.console.permissions import may_add_devices, may_change_devices, may_delete_devices, require
from apps.console.serializers import agent_server_names, assigned_agent_payload, iso
from apps.console.target_config import visible_agent_id
from apps.inventory.models import Device, Site
from apps.snmp.models import CREDENTIAL_PROFILE_RE, DevicePoll, InterfaceSample, SnmpConfig

logger = logging.getLogger("apps.console")

NAME_MAX_LENGTH = Device._meta.get_field("name").max_length
ADDRESS_MAX_LENGTH = Device._meta.get_field("management_address").max_length
DESCRIPTION_MAX_LENGTH = 2000
PROFILE_MAX_LENGTH = SnmpConfig._meta.get_field("credential_profile").max_length
MAX_BODY_BYTES = 16 * 1024
NOT_PERMITTED = "This account may not add or change devices."
TYPES = tuple(Device.DeviceType.values)
VERSIONS = tuple(SnmpConfig.Version.values)
SNMP_FILTERS = ("all", "configured", "none")
SORT_KEYS = ("name", "type", "address", "created")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"name": "asc", "type": "asc", "address": "asc", "created": "desc"}
LIST_PARAMS = ("q", "snmp", "sort", "dir", *SCOPE_PARAMS, *PAGE_PARAMS)
SEARCH_FIELDS = ("name", "management_address", "description", "site__name", "site__customer__name")
# Body field -> model field, for the device and for its SNMP configuration.
DEVICE_FIELDS = {
    "name": "name",
    "type": "device_type",
    "address": "management_address",
    "enabled": "enabled",
    "description": "description",
    "siteId": "site_id",
    "agentId": "assigned_agent_id",
}
SNMP_FIELDS = {
    "version": "version",
    "port": "port",
    "credentialProfile": "credential_profile",
    "pollIntervalSeconds": "poll_interval_seconds",
    "timeoutSeconds": "timeout_seconds",
    "retries": "retries",
}
BODY_FIELDS = (*DEVICE_FIELDS, "snmp")
REQUIRED_ON_CREATE = ("name", "address")
DEVICE_ERROR_FIELDS = {
    **{model: body for body, model in DEVICE_FIELDS.items()},
    "site": "siteId",
    "assigned_agent": "agentId",
    NON_FIELD_ERRORS: "nonField",
}
SNMP_ERROR_FIELDS = {**{model: f"snmp.{body}" for body, model in SNMP_FIELDS.items()}, NON_FIELD_ERRORS: "snmp.nonField"}
NAME_TAKEN = tuple(c.violation_error_message for c in Device._meta.constraints)
# The only columns ever read for a device: never the credential profile.
FIELDS = (
    "id",
    "name",
    "device_type",
    "management_address",
    "enabled",
    "description",
    "site_id",
    "site__name",
    "site__customer__name",
    "assigned_agent_id",
    "assigned_agent__name",
    "assigned_agent__last_seen_at",
    "assigned_agent__server_id",
    "snmp_config__version",
    "snmp_config__port",
    "snmp_config__poll_interval_seconds",
    "snmp_config__timeout_seconds",
    "snmp_config__retries",
    "has_history",
    "created_at",
    "updated_at",
)
HISTORY_MESSAGE = (
    "SNMP history exists for this device. Disable the device, and delete it after the history has "
    "been purged (manage.py purge_snmp_data)."
)


# -- reading -------------------------------------------------------------------------------


def visible_devices(visibility: Visibility, scope: Scope | None = None):
    """Devices the user may see, with whether history exists: the start of every device query here."""
    polled = Exists(DevicePoll.objects.filter(device=OuterRef("pk")))
    sampled = Exists(InterfaceSample.objects.filter(interface__device=OuterRef("pk")))
    return visibility.filter(Device.objects.all(), scope=scope).annotate(has_history=polled | sampled)


def serialize(row: dict, servers: dict, now: datetime) -> dict:
    snmp = None
    if row["snmp_config__version"] is not None:
        snmp = {
            "version": row["snmp_config__version"],
            "port": row["snmp_config__port"],
            "pollIntervalSeconds": row["snmp_config__poll_interval_seconds"],
            "timeoutSeconds": row["snmp_config__timeout_seconds"],
            "retries": row["snmp_config__retries"],
        }
    item = {
        "id": str(row["id"]),
        "name": row["name"],
        "type": row["device_type"],
        "address": row["management_address"],
        "enabled": row["enabled"],
        "description": row["description"],
        "siteId": str(row["site_id"]) if row["site_id"] is not None else None,
        "agentAssigned": row["assigned_agent_id"] is not None,
        "agent": assigned_agent_payload(row, servers, now),
        "snmp": snmp,
        "hasHistory": row["has_history"],
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
    }
    if row["site__customer__name"] is not None:
        item["customerName"] = row["site__customer__name"]
    if row["site__name"] is not None:
        item["siteName"] = row["site__name"]
    return item


def serialize_rows(visibility: Visibility, rows: list[dict], now: datetime) -> list[dict]:
    servers = agent_server_names(visibility, rows)
    return [serialize(row, servers, now) for row in rows]


def ordering(sort: str, direction: str) -> list:
    descending = direction == "desc"
    tie = [name_order("name"), "pk"]
    if sort == "name":
        return [name_order("name", descending=descending), "pk"]
    if sort == "address":
        return [name_order("management_address", descending=descending), *tie]
    field = {"type": "device_type", "created": "created_at"}[sort]
    return [F(field).desc() if descending else F(field).asc(), *tie]


def detail_payload(visibility: Visibility, device_id: UUID, now: datetime) -> dict:
    row = visibility.get(visible_devices(visibility).values(*FIELDS), device_id)
    (item,) = serialize_rows(visibility, [row], now)
    return {"generatedAt": iso(now), "item": item}


@console_api(methods=("GET", "POST"))
def device_collection(request):
    if request.method == "POST":
        return create_device(request)
    now = timezone.now()
    params = QueryParams(request, LIST_PARAMS)
    scope = params.scope(request.visibility)
    words = params.search()
    snmp = params.choice("snmp", SNMP_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "name")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)
    in_scope = visible_devices(request.visibility, scope)
    matching = apply_search(in_scope, words, SEARCH_FIELDS)
    if snmp != "all":
        matching = matching.filter(snmp_config__isnull=snmp == "none")
    total = matching.count()
    scope_total = in_scope.count() if words or snmp != "all" else total
    items: list[dict] = []
    if page.offset < total:
        rows = list(matching.order_by(*ordering(sort, direction)).values(*FIELDS)[page.offset : page.offset + page.size])
        items = serialize_rows(request.visibility, rows, now)
    return JsonResponse({"generatedAt": iso(now), "items": items, "page": page.payload(total), "scopeTotal": scope_total})


@console_api(methods=("GET", "PATCH", "DELETE"))
def device_item(request, device_id: UUID):
    if request.method == "PATCH":
        return change_device(request, device_id)
    if request.method == "DELETE":
        return delete_device(request, device_id)
    QueryParams(request, ())
    return JsonResponse(detail_payload(request.visibility, device_id, timezone.now()))


# -- parsing -------------------------------------------------------------------------------


def parse_snmp(value, errors: dict, *, creating: bool) -> dict | None:
    """The SNMP values a body sets (``None`` for none), their errors as ``snmp.<field>``."""
    if value is None:
        return None
    if not isinstance(value, dict):
        errors["snmp"] = ["Expected an object, or null for a device that is not polled."]
        return None
    problems: dict[str, list[str]] = {}
    unknown_fields(value, SNMP_FIELDS, problems)
    if creating and "credentialProfile" not in value:
        problems["credentialProfile"] = ["Required."]
    values: dict = {}
    for name in value:
        if name not in SNMP_FIELDS:
            continue
        if name == "version":
            parsed = choice(value, name, errors=problems, choices=VERSIONS)
        elif name == "port":
            parsed = integer(value, name, errors=problems, minimum=1, maximum=65535)
        elif name == "credentialProfile":
            parsed = text(value, name, limit=PROFILE_MAX_LENGTH, errors=problems).strip()
            if name not in problems and not parsed:
                problems[name] = ["Required."]
        elif name == "pollIntervalSeconds":
            parsed = integer(value, name, errors=problems, minimum=30, maximum=86400)
        elif name == "timeoutSeconds":
            parsed = integer(value, name, errors=problems, minimum=1, maximum=60)
        else:
            parsed = integer(value, name, errors=problems, minimum=0, maximum=5)
        if name not in problems:
            values[SNMP_FIELDS[name]] = parsed
    for name, messages in problems.items():
        errors[f"snmp.{name}"] = messages
    return values


def parse_device(visibility: Visibility, data: dict, *, creating: bool) -> tuple[dict, dict | None, bool]:
    """``(device values, SNMP values or None, whether snmp was sent)``, or a 400 with what is wrong."""
    errors: dict[str, list[str]] = {}
    unknown_fields(data, BODY_FIELDS, errors)
    if creating:
        for name in REQUIRED_ON_CREATE:
            if name not in data:
                errors[name] = ["Required."]
    values: dict = {}
    for name in data:
        if name not in DEVICE_FIELDS:
            continue
        if name == "name":
            parsed = text(data, name, limit=NAME_MAX_LENGTH, errors=errors).strip()
            if name not in errors and not parsed:
                errors[name] = ["Required."]
        elif name == "type":
            parsed = choice(data, name, errors=errors, choices=TYPES)
        elif name == "address":
            parsed = text(data, name, limit=ADDRESS_MAX_LENGTH, errors=errors).strip()
            if name not in errors and not parsed:
                errors[name] = ["Required."]
        elif name == "enabled":
            parsed = boolean(data, name, errors=errors)
        elif name == "description":
            parsed = text(data, name, limit=DESCRIPTION_MAX_LENGTH, errors=errors, multiline=True)
        elif name == "siteId":
            parsed = reference(data, name, errors=errors, model=Site, label="site")
        else:
            parsed = visible_agent_id(visibility, data, errors)
        if name not in errors:
            values[DEVICE_FIELDS[name]] = parsed
    snmp = parse_snmp(data["snmp"], errors, creating=creating) if "snmp" in data else None
    if errors:
        raise validation_error(errors)
    return values, snmp, "snmp" in data


def device_values(device: Device, config: SnmpConfig | None) -> dict:
    """The device's fields by the names the API gives them, for the audit trail: never the credential profile."""
    values = {body: getattr(device, model) for body, model in DEVICE_FIELDS.items()}
    values["snmp"] = config is not None
    if config is not None:
        for body, model in SNMP_FIELDS.items():
            if body != "credentialProfile":
                values[f"snmp.{body}"] = getattr(config, model)
    return values


def save_device(device: Device) -> None:
    try:
        with transaction.atomic():
            device.save()
    except ValidationError as error:
        fields = model_errors(error, DEVICE_ERROR_FIELDS)
        taken = next((message for messages in fields.values() for message in messages if message in NAME_TAKEN), None)
        if taken is not None:
            raise ApiError(409, "device_exists", taken) from None
        raise validation_error(fields) from None
    except IntegrityError:
        # The name taken by a device saved meanwhile (the constraint checks it again).
        raise ApiError(409, "device_exists", NAME_TAKEN[0]) from None


def save_config(config: SnmpConfig) -> None:
    try:
        with transaction.atomic():
            config.save()
    except ValidationError as error:
        raise validation_error(model_errors(error, SNMP_ERROR_FIELDS)) from None


# -- writing -------------------------------------------------------------------------------


def create_device(request):
    now = timezone.now()
    user = request.user
    require(may_add_devices(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values, snmp, _ = parse_device(request.visibility, json_object(request, max_bytes=MAX_BODY_BYTES), creating=True)
    device = Device(**values)
    config = SnmpConfig(device=device, **snmp) if snmp is not None else None
    with transaction.atomic():
        save_device(device)
        if config is not None:
            save_config(config)
        changed = audit.changes({}, device_values(device, config))
        if config is not None:
            changed["credentialProfileChanged"] = {"before": None, "after": True}
        audit.record(user, action="device_created", target_type=audit.DEVICE, target_id=device.pk, target_name=device.name, changed=changed)
    logger.info("Device created (device=%s, site=%s, agent=%s, snmp=%s, user_id=%s)", device.pk, device.site_id, device.assigned_agent_id, config is not None, user.pk)
    response = JsonResponse(detail_payload(request.visibility, device.pk, now), status=201)
    response["Location"] = f"{request.path}{device.pk}/"
    return response


def change_device(request, device_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_change_devices(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values, snmp, snmp_sent = parse_device(request.visibility, json_object(request, max_bytes=MAX_BODY_BYTES), creating=False)
    with transaction.atomic():
        device = request.visibility.get(Device.objects.select_for_update(no_key=True), device_id)
        config = SnmpConfig.objects.select_for_update(no_key=True).filter(device=device).first()
        before = device_values(device, config)
        profile_changed = False
        for field, value in values.items():
            setattr(device, field, value)
        if snmp_sent and snmp is None and config is not None:
            config.delete()
            config = None
        elif snmp_sent and snmp is not None:
            if config is None:
                if "credential_profile" not in snmp:
                    raise validation_error({"snmp.credentialProfile": ["Required."]})
                config = SnmpConfig(device=device)
            for field, value in snmp.items():
                if field == "credential_profile":
                    profile_changed = value != config.credential_profile
                setattr(config, field, value)
        after = device_values(device, config)
        if after != before or profile_changed:
            save_device(device)
            if config is not None:
                save_config(config)
            changed = audit.changes(before, after)
            if profile_changed:
                changed["credentialProfileChanged"] = {"before": None, "after": True}
            audit.record(user, action="device_changed", target_type=audit.DEVICE, target_id=device.pk, target_name=device.name, changed=changed)
            logger.info("Device changed (device=%s, site=%s, agent=%s, snmp=%s, user_id=%s)", device.pk, device.site_id, device.assigned_agent_id, config is not None, user.pk)
    return JsonResponse(detail_payload(request.visibility, device.pk, now))


def delete_device(request, device_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_delete_devices(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    data = json_object(request, max_bytes=1024, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: a deletion has no options."] for name in sorted(data)})
    with transaction.atomic():
        device = request.visibility.get(Device.objects.select_for_update(), device_id)
        if DevicePoll.objects.filter(device=device).exists() or InterfaceSample.objects.filter(interface__device=device).exists():
            raise ApiError(409, "device_has_history", HISTORY_MESSAGE)
        config = SnmpConfig.objects.filter(device=device).first()
        done = {"id": str(device.pk), "name": device.name}
        audit.record(
            user,
            action="device_deleted",
            target_type=audit.DEVICE,
            target_id=device.pk,
            target_name=device.name,
            changed=audit.changes(device_values(device, config), {}),
        )
        device.delete()
    logger.info("Device deleted (device=%s, user_id=%s)", done["id"], user.pk)
    return JsonResponse({"generatedAt": iso(now), "deleted": done})
