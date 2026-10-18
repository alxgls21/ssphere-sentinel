"""Alert rules: ``GET/POST /alert-rules/``, ``GET/PATCH /alert-rules/<id>/``, ``GET /alert-rules/options/``.

Who: every endpoint needs global visibility (``console.view_all_customers``, or a
superuser): a rule may concern every customer, and the rules name the customers and
sites they are for. Then ``alerts.view_alertrule`` (or ``change_alertrule``) to
read, ``alerts.add_alertrule`` to create, ``alerts.change_alertrule`` to change; the
options need any of the three. Otherwise 403. Rules are never deleted here: an
incident keeps its rule, so a rule is disabled instead (the admin deletes one that
never had an incident).

AlertRule::

    {"id", "key": str | null, "name", "description", "enabled",
     "kind": server | container | target | device | interface, "condition": "health",
     "health": critical | warning | unknown, "reason": str | null, "severity": critical | warning,
     "activationSeconds": int, "recoverySeconds": int,
     "scope": {"type": all | customer | site, "customerId": str | null, "customerName": str | null,
               "siteId": str | null, "siteName": str | null},
     "openIncidents": int, "createdAt", "updatedAt", "version": int, "canEdit": bool}

``key`` names the rules Sentinel installed. ``scope.type`` ``all`` is every object,
including those on no site; a ``site`` scope also gives the site's customer.

List::

    {"generatedAt", "items": [AlertRule], "page": {number, size, total, pages},
     "counts": {"enabled": int, "disabled": int}, "scopeTotal": int}

Query parameters (anything else, or a repeated one, is a 400): ``q`` (every word in
the name, description, customer or site name), ``enabled`` (all | enabled |
disabled), ``kind`` (all | a kind), ``severity`` (all | critical | warning), ``scope``
(all | global | customer | site), ``sort`` (name | kind | severity | updated), ``dir``
(asc | desc), ``page``, ``pageSize``. ``counts`` are over every filter but
``enabled``; ``scopeTotal`` is every rule.

Detail: ``{"generatedAt", "item": AlertRule, "changeEffects": CHANGE_EFFECTS}``.

Create: ``POST`` with the CSRF token and a JSON object: ``name``, ``kind``, ``health``
and ``severity`` are required; ``description`` (""), ``enabled`` (true), ``reason``
(null: any), ``activationSeconds`` (60), ``recoverySeconds`` (120), ``customerId`` and
``siteId`` (null; at most one) are optional. 201 with the detail.

Change: ``PATCH`` with the CSRF token and a JSON object of the fields to change and
the ``version`` the client read. Any field of the create body but ``kind``, which
never changes (sending the same kind is accepted). A ``version`` that is no longer the
rule's is a 409 ``version_conflict``, and nothing changes: read the rule again.
Nothing to change: the rule as it is, its version unchanged. Otherwise 200::

    {"generatedAt", "item": AlertRule, "effects": {"openIncidents": int,
     "closes": [rule_disabled | rule_changed | out_of_scope], "closesAll": bool}}

The engine applies a change at its next cycle, and some changes end the rule's open
incidents then (``changeEffects``): disabling it ends them all (``rule_disabled``); a
new health, reason or severity ends them all (``rule_changed``: they were opened
under the old condition); a new scope ends those of objects outside it
(``out_of_scope``). ``effects`` says which of these this change does, and how many
incidents were open when it was made. A name, description or timing ends nothing.

Invalid values are a 400 ``validation_error`` with ``fields``: the field names above,
``nonField`` for a problem of the whole, ``version`` when it is missing or not a
number. Unknown fields are refused there too. The body is at most 16 KiB (room for the
longest name and description, whatever their characters and however they are escaped).

Options::

    {"generatedAt",
     "kinds": [{"value", "label", "conditions": [{"health", "label", "reasons": [str]}]}],
     "severities": [{"value", "label"}],
     "defaults": {"enabled": true, "activationSeconds": 60, "recoverySeconds": 120},
     "limits": {"maxDurationSeconds": 86400, "nameMaxLength": 255, "descriptionMaxLength": 2000},
     "changeEffects": CHANGE_EFFECTS}

``kinds`` lists, for each kind, the conditions that can fire for it and the reasons each
may be narrowed to: what the server accepts. The customers and sites a scope can name
are ``/scope/``'s.
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.core.exceptions import NON_FIELD_ERRORS, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, F, OuterRef, Subquery, Value
from django.db.models.functions import Coalesce
from django.http import JsonResponse
from django.utils import timezone

from apps.alerts import audit
from apps.alerts.conditions import MATCHES, EntityKind, HealthCondition, Severity, reasons_for
from apps.alerts.models import MAX_DURATION_SECONDS, AlertRule, CloseReason, ConfigurationSource, Incident
from apps.console.http import ApiError, console_api, json_object, validation_error
from apps.console.listing import apply_search, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, PageRequest, QueryParams
from apps.console.permissions import may_add_rules, may_change_rules, may_view_rules, require
from apps.console.serializers import iso
from apps.inventory.models import Customer, Site

logger = logging.getLogger("apps.console")

NAME_MAX_LENGTH = AlertRule._meta.get_field("name").max_length
DESCRIPTION_MAX_LENGTH = 2000
# The longest name and description, each character escaped as JSON may (\uXXXX), and the rest.
MAX_BODY_BYTES = 16 * 1024
DEFAULTS = {"enabled": True, "activationSeconds": 60, "recoverySeconds": 120}
# The changes that end open incidents of the rule at the engine's next cycle, and how.
CHANGE_EFFECTS = {
    "enabled": {"to": False, "closes": CloseReason.RULE_DISABLED.value, "which": "all"},
    "health": {"closes": CloseReason.RULE_CHANGED.value, "which": "all"},
    "reason": {"closes": CloseReason.RULE_CHANGED.value, "which": "all"},
    "severity": {"closes": CloseReason.RULE_CHANGED.value, "which": "all"},
    "scope": {"closes": CloseReason.OUT_OF_SCOPE.value, "which": "outside the new scope"},
}

ENABLED_FILTERS = {"all": None, "enabled": True, "disabled": False}
KIND_FILTERS = ("all", *EntityKind.values)
SEVERITY_FILTERS = ("all", *Severity.values)
SCOPE_FILTERS = ("all", "global", "customer", "site")
SORT_KEYS = ("name", "kind", "severity", "updated")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"name": "asc", "kind": "asc", "severity": "asc", "updated": "desc"}
LIST_PARAMS = ("q", "enabled", "kind", "severity", "scope", "sort", "dir", *PAGE_PARAMS)
SEARCH_FIELDS = ("name", "description", "customer__name", "site__name", "site__customer__name")
FIELDS = (
    "id",
    "key",
    "name",
    "description",
    "enabled",
    "entity_kind",
    "condition",
    "health",
    "reason",
    "severity",
    "activation_seconds",
    "recovery_seconds",
    "customer_id",
    "customer__name",
    "site_id",
    "site__name",
    "site__customer_id",
    "site__customer__name",
    "open_incidents",
    "created_at",
    "updated_at",
    "version",
)

# The body's fields, and the model field each sets.
BODY_FIELDS = {
    "name": "name",
    "description": "description",
    "enabled": "enabled",
    "kind": "entity_kind",
    "health": "health",
    "reason": "reason",
    "severity": "severity",
    "activationSeconds": "activation_seconds",
    "recoverySeconds": "recovery_seconds",
    "customerId": "customer_id",
    "siteId": "site_id",
}
REQUIRED_ON_CREATE = ("name", "kind", "health", "severity")
CONDITION_FIELDS = ("health", "reason", "severity")
# Model field (as validation errors name it) -> body field.
ERROR_FIELDS = {
    **{model: body for body, model in BODY_FIELDS.items()},
    "customer": "customerId",
    "site": "siteId",
    NON_FIELD_ERRORS: "nonField",
}
NAME_TAKEN = next(
    constraint.violation_error_message
    for constraint in AlertRule._meta.constraints
    if constraint.name == "uniq_alert_rule_name_ci"
)


def with_columns(queryset):
    """The open incidents of each rule (the open-incident index covers it), for the list and the detail."""
    open_incidents = (
        Incident.objects.filter(rule=OuterRef("pk"), status__in=Incident.OPEN)
        .order_by()
        .values("rule")
        .annotate(n=Count("pk"))
        .values("n")
    )
    return queryset.annotate(open_incidents=Coalesce(Subquery(open_incidents), Value(0)))


def serialize(row: dict, *, may_change: bool) -> dict:
    if row["site_id"] is not None:
        scope = {
            "type": "site",
            "customerId": str(row["site__customer_id"]),
            "customerName": row["site__customer__name"],
            "siteId": str(row["site_id"]),
            "siteName": row["site__name"],
        }
    elif row["customer_id"] is not None:
        scope = {
            "type": "customer",
            "customerId": str(row["customer_id"]),
            "customerName": row["customer__name"],
            "siteId": None,
            "siteName": None,
        }
    else:
        scope = {"type": "all", "customerId": None, "customerName": None, "siteId": None, "siteName": None}
    return {
        "id": str(row["id"]),
        "key": row["key"],
        "name": row["name"],
        "description": row["description"],
        "enabled": row["enabled"],
        "kind": row["entity_kind"],
        "condition": row["condition"],
        "health": row["health"],
        "reason": row["reason"] or None,
        "severity": row["severity"],
        "activationSeconds": row["activation_seconds"],
        "recoverySeconds": row["recovery_seconds"],
        "scope": scope,
        "openIncidents": row["open_incidents"],
        "createdAt": iso(row["created_at"]),
        "updatedAt": iso(row["updated_at"]),
        "version": row["version"],
        "canEdit": may_change,
    }


def ordering(sort: str, direction: str) -> list:
    tie = [name_order("name"), "pk"]
    if sort == "name":
        return [name_order("name", descending=direction == "desc"), "pk"]
    field = {"kind": "entity_kind", "severity": "severity", "updated": "updated_at"}[sort]
    return [F(field).asc() if direction == "asc" else F(field).desc(), *tie]


@console_api(methods=("GET", "POST"))
def rule_collection(request):
    if request.method == "POST":
        return create_rule(request)
    return rule_list(request)


def rule_list(request):
    now = timezone.now()
    require(may_view_rules(request.user, request.visibility), "This account may not see alert rules.")
    params = QueryParams(request, LIST_PARAMS)
    words = params.search()
    enabled = ENABLED_FILTERS[params.choice("enabled", tuple(ENABLED_FILTERS), "all")]
    kind = params.choice("kind", KIND_FILTERS, "all")
    severity = params.choice("severity", SEVERITY_FILTERS, "all")
    scope = params.choice("scope", SCOPE_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "name")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    every = AlertRule.objects.all()
    matching = apply_search(every, words, SEARCH_FIELDS)
    if kind != "all":
        matching = matching.filter(entity_kind=kind)
    if severity != "all":
        matching = matching.filter(severity=severity)
    if scope == "global":
        matching = matching.filter(customer__isnull=True, site__isnull=True)
    elif scope == "customer":
        matching = matching.filter(customer__isnull=False)
    elif scope == "site":
        matching = matching.filter(site__isnull=False)
    counts = {"enabled": 0, "disabled": 0}
    for row in matching.order_by().values("enabled").annotate(n=Count("pk")):
        counts["enabled" if row["enabled"] else "disabled"] = row["n"]
    narrowed = bool(words) or kind != "all" or severity != "all" or scope != "all"
    scope_total = every.count() if narrowed else sum(counts.values())
    total = sum(counts.values()) if enabled is None else counts["enabled" if enabled else "disabled"]

    items: list[dict] = []
    if page.offset < total:
        rows = matching if enabled is None else matching.filter(enabled=enabled)
        rows = list(with_columns(rows).order_by(*ordering(sort, direction)).values(*FIELDS)[page.offset : page.offset + page.size])
        may_change = may_change_rules(request.user, request.visibility)
        items = [serialize(row, may_change=may_change) for row in rows]
    return JsonResponse(page_envelope(now, items, page, total=total, counts=counts, scope_total=scope_total))


def detail_item(request, rule_id) -> dict:
    row = with_columns(AlertRule.objects.filter(pk=rule_id)).values(*FIELDS).first()
    if row is None:
        raise ApiError(404, "not_found", "Not found.")
    return serialize(row, may_change=may_change_rules(request.user, request.visibility))


@console_api(methods=("GET", "PATCH"))
def rule_item(request, rule_id: UUID):
    if request.method == "PATCH":
        return change_rule(request, rule_id)
    now = timezone.now()
    require(may_view_rules(request.user, request.visibility), "This account may not see alert rules.")
    QueryParams(request, ())
    return JsonResponse({"generatedAt": iso(now), "item": detail_item(request, rule_id), "changeEffects": CHANGE_EFFECTS})


# -- writing -----------------------------------------------------------------------------


def _text(value, *, limit: int, errors: dict, name: str) -> str | None:
    if not isinstance(value, str):
        errors[name] = ["Expected text."]
        return None
    if "\x00" in value or any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        errors[name] = ["This text cannot be stored."]
        return None
    if len(value) > limit:
        errors[name] = [f"At most {limit} characters."]
        return None
    return value


def _reference(model, value, *, errors: dict, name: str, label: str):
    if value is None:
        return None
    try:
        parsed = UUID(value) if isinstance(value, str) and len(value) <= 36 else None
    except ValueError:
        parsed = None
    if parsed is None or str(parsed) != value.lower():
        errors[name] = [f"Expected the id of a {label}."]
        return None
    if not model.objects.filter(pk=parsed).exists():
        errors[name] = [f"No such {label}."]
        return None
    return parsed


def parse_body(data: dict, *, creating: bool) -> tuple[dict, dict[str, list[str]]]:
    """The model values a body sets, and the errors in it (by body field)."""
    errors: dict[str, list[str]] = {}
    allowed = set(BODY_FIELDS) | (set() if creating else {"version"})
    for name in sorted(set(data) - allowed):
        errors[name] = ["Unknown field."]
    if creating:
        for name in REQUIRED_ON_CREATE:
            if name not in data:
                errors[name] = ["Required."]
    values: dict = {}
    for name, value in data.items():
        if name not in BODY_FIELDS:
            continue
        model_field = BODY_FIELDS[name]
        if name == "name":
            parsed = _text(value, limit=NAME_MAX_LENGTH, errors=errors, name=name)
            parsed = parsed.strip() if parsed is not None else None  # as the model stores it
        elif name == "description":
            parsed = _text(value, limit=DESCRIPTION_MAX_LENGTH, errors=errors, name=name)
        elif name in ("kind", "health", "severity"):
            parsed = _text(value, limit=32, errors=errors, name=name)
        elif name == "reason":
            parsed = "" if value is None else _text(value, limit=32, errors=errors, name=name)
        elif name == "enabled":
            parsed = value if isinstance(value, bool) else None
            if parsed is None:
                errors[name] = ["Expected true or false."]
        elif name in ("activationSeconds", "recoverySeconds"):
            parsed = value if isinstance(value, int) and not isinstance(value, bool) else None
            if parsed is None or not 0 <= parsed <= MAX_DURATION_SECONDS:
                errors[name] = [f"Expected a whole number of seconds from 0 to {MAX_DURATION_SECONDS}."]
                parsed = None
        elif name == "customerId":
            parsed = _reference(Customer, value, errors=errors, name=name, label="customer")
        else:
            parsed = _reference(Site, value, errors=errors, name=name, label="site")
        if name not in errors:
            values[model_field] = parsed
    return values, errors


def model_errors(error: ValidationError) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    for model_field, messages in error.message_dict.items():
        name = ERROR_FIELDS.get(model_field, "nonField")
        for message in messages:
            if message == NAME_TAKEN:
                name = "name"
            if message not in fields.setdefault(name, []):
                fields[name].append(message)
    return fields


def save(rule: AlertRule) -> None:
    """Save (validated by the model) in a savepoint; a 400 with what is wrong, field by field."""
    try:
        with transaction.atomic():
            rule.save()
    except ValidationError as error:
        raise validation_error(model_errors(error)) from None
    except IntegrityError:
        # A name taken by a rule saved meanwhile (the constraint checks it again).
        raise validation_error({"name": [NAME_TAKEN]}) from None


def create_rule(request):
    now = timezone.now()
    require(may_add_rules(request.user, request.visibility), "This account may not create alert rules.")
    QueryParams(request, ())
    values, errors = parse_body(json_object(request, max_bytes=MAX_BODY_BYTES), creating=True)
    if errors:
        raise validation_error(errors)
    defaults = {
        "enabled": DEFAULTS["enabled"],
        "activation_seconds": DEFAULTS["activationSeconds"],
        "recovery_seconds": DEFAULTS["recoverySeconds"],
    }
    rule = AlertRule(**{**defaults, **values})
    with transaction.atomic():
        save(rule)
        audit.rule_saved(request.user, rule, {}, created=True, source=ConfigurationSource.CONSOLE)
    logger.info("Alert rule created (rule=%s, user_id=%s)", rule.pk, request.user.pk)
    payload = {"generatedAt": iso(now), "item": detail_item(request, rule.pk), "changeEffects": CHANGE_EFFECTS}
    return JsonResponse(payload, status=201)


def effects(rule: AlertRule, before: dict, open_incidents: int) -> dict:
    after = audit.rule_values(rule)
    closes = []
    if before["enabled"] and not after["enabled"]:
        closes.append(CloseReason.RULE_DISABLED.value)
    elif any(before[name] != after[name] for name in CONDITION_FIELDS):
        closes.append(CloseReason.RULE_CHANGED.value)
    if (before["customerId"], before["siteId"]) != (after["customerId"], after["siteId"]):
        closes.append(CloseReason.OUT_OF_SCOPE.value)
    closes_all = bool(open_incidents) and any(
        reason in (CloseReason.RULE_DISABLED, CloseReason.RULE_CHANGED) for reason in closes
    )
    return {"openIncidents": open_incidents, "closes": closes, "closesAll": closes_all}


def change_rule(request, rule_id: UUID):
    now = timezone.now()
    require(may_change_rules(request.user, request.visibility), "This account may not change alert rules.")
    QueryParams(request, ())
    data = json_object(request, max_bytes=MAX_BODY_BYTES)
    values, errors = parse_body(data, creating=False)
    version = data.get("version")
    if not isinstance(version, int) or isinstance(version, bool):
        errors["version"] = ["Required: the version of the rule you read."]
    with transaction.atomic():
        # The row is held until the end: no other change slips in between the check and the save.
        rule = AlertRule.objects.select_for_update().filter(pk=rule_id).first()
        if rule is None:
            raise ApiError(404, "not_found", "Not found.")
        if "entity_kind" in values and values.pop("entity_kind") != rule.entity_kind:
            errors["kind"] = ["The kind of a rule cannot be changed. Disable it and add a new rule."]
        if errors:
            raise validation_error(errors)
        if version != rule.version:
            raise ApiError(
                409, "version_conflict", "This rule was changed since you read it. Read it again, then make your change."
            )
        before = audit.rule_values(rule)
        for field, value in values.items():
            setattr(rule, field, value)
        if audit.rule_values(rule) == before:
            return JsonResponse({"generatedAt": iso(now), "item": detail_item(request, rule.pk), "effects": None})
        open_incidents = Incident.objects.filter(rule=rule, status__in=Incident.OPEN).count()
        save(rule)
        audit.rule_saved(request.user, rule, before, created=False, source=ConfigurationSource.CONSOLE)
        result = effects(rule, before, open_incidents)
    logger.info("Alert rule changed (rule=%s, user_id=%s, version=%s)", rule.pk, request.user.pk, rule.version)
    return JsonResponse({"generatedAt": iso(now), "item": detail_item(request, rule.pk), "effects": result})


# -- options -----------------------------------------------------------------------------


@console_api()
def rule_options(request):
    now = timezone.now()
    user, visibility = request.user, request.visibility
    require(
        may_view_rules(user, visibility) or may_add_rules(user, visibility),
        "This account may not see alert rules.",
    )
    QueryParams(request, ())
    kinds = []
    for kind in EntityKind:
        conditions = [
            {"health": condition.value, "label": condition.label, "reasons": list(reasons_for(kind, condition))}
            for condition in HealthCondition
            if condition in MATCHES and reasons_for(kind, condition)
        ]
        kinds.append({"value": kind.value, "label": kind.label, "conditions": conditions})
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "kinds": kinds,
            "severities": [{"value": severity.value, "label": severity.label} for severity in Severity],
            "defaults": DEFAULTS,
            "limits": {
                "maxDurationSeconds": MAX_DURATION_SECONDS,
                "nameMaxLength": NAME_MAX_LENGTH,
                "descriptionMaxLength": DESCRIPTION_MAX_LENGTH,
            },
            "changeEffects": CHANGE_EFFECTS,
        }
    )
