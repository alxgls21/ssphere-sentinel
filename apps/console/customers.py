"""Customers and sites from the console: ``GET/POST /customers/``, ``GET/PATCH/DELETE /customers/<id>/``,
``GET/POST /sites/``, ``GET/PATCH/DELETE /sites/<id>/``.

Who: reading needs what reading anything needs (the grants: a restricted account sees its own
customers and sites, and a hidden or unknown id is a 404). Writing needs what configuring
monitoring needs (``alerts.change_alertrule`` with global visibility) and the admin's model
permission for the action (``inventory.add_customer``, ``change_customer``, ``delete_customer``;
the same three on ``inventory.Site``); otherwise 403. See ``apps.console.permissions``.

Customer::

    {"id", "name", "notes", "sites": int, "servers": int, "devices": int, "targets": int,
     "domains": int, "createdAt", "updatedAt"}

Site::

    {"id", "customerId", "customerName", "name", "description", "servers": int, "devices": int,
     "targets": int, "createdAt", "updatedAt"}

The counts are what belongs to the object (a customer's through its sites, plus its domains):
what must go elsewhere before it can be deleted.

Lists: ``{"generatedAt", "items", "page": {number, size, total, pages}, "scopeTotal"}``, with
``q`` (words, every one in the name, the notes or description, or the customer's name), ``sort``
(``name`` | ``created``), ``dir``, ``page`` and ``pageSize``; the site list also takes
``customer`` (an id from ``/scope/``; unknown or hidden: 404). The customer detail is
``{"generatedAt", "item": Customer, "sites": [Site]}``; the site detail ``{"generatedAt", "item": Site}``.

Create: ``POST /customers/`` with ``{"name", "notes": str ("")}``; ``POST /sites/`` with
``{"customerId", "name", "description": str ("")}``. 201 with ``Location`` and the detail. A
name another customer has, in any case, is a 409 ``customer_exists``; a name another site of the
customer has, a 409 ``site_exists``. Invalid values are a 400 ``validation_error`` with ``fields``
(unknown fields are refused there too); the body is at most 16 KiB. The model validates the
rest (``apps.inventory.models``: names are stripped, blank names refused).

Change: ``PATCH`` with any of the create fields (a site may also move to another ``customerId``,
which changes who sees everything on it). 200 with the detail; nothing to change answers it as it is.

Delete: ``DELETE`` with no body. Refused, 409 ``customer_in_use`` or ``site_in_use``, with a
message that counts what still belongs to it, while a customer has sites, monitored domains or
alert rules, or a site has servers, devices, network targets, alert rules or incidents: nothing
is ever deleted along with a customer or a site. The access grants to it go with it. 200
``{"generatedAt", "deleted": {"id", "name"}}``.

Every write is logged (``apps.console``) and recorded in the audit trail (``apps.console.audit``).
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.core.exceptions import NON_FIELD_ERRORS, ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, F, IntegerField, OuterRef, ProtectedError, Subquery, Value
from django.db.models.functions import Coalesce
from django.http import JsonResponse
from django.utils import timezone

from apps.alerts.models import AlertRule, Incident
from apps.console import audit
from apps.console.fields import model_errors, reference, text, unknown_fields
from apps.console.http import ApiError, console_api, json_object, validation_error
from apps.console.listing import apply_search, name_order
from apps.console.params import PAGE_PARAMS, PageRequest, QueryParams
from apps.console.permissions import (
    may_add_customers,
    may_add_sites,
    may_change_customers,
    may_change_sites,
    may_delete_customers,
    may_delete_sites,
    require,
)
from apps.console.serializers import iso
from apps.infrastructure.models import Server
from apps.inventory.models import Customer, Device, Site
from apps.network.models import NetworkTarget
from apps.web.models import MonitoredDomain

logger = logging.getLogger("apps.console")

NAME_MAX_LENGTH = Customer._meta.get_field("name").max_length
NOTES_MAX_LENGTH = 2000
# The longest name and notes, each character escaped as JSON may (\uXXXX).
MAX_BODY_BYTES = 16 * 1024
SORT_KEYS = ("name", "created")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"name": "asc", "created": "desc"}
CUSTOMER_LIST_PARAMS = ("q", "sort", "dir", *PAGE_PARAMS)
SITE_LIST_PARAMS = ("q", "customer", "sort", "dir", *PAGE_PARAMS)
CUSTOMER_FIELDS = ("name", "notes")
SITE_FIELDS = ("customerId", "name", "description")
CUSTOMER_ERROR_FIELDS = {"name": "name", "notes": "notes", NON_FIELD_ERRORS: "nonField"}
SITE_ERROR_FIELDS = {"name": "name", "description": "description", "customer": "customerId", NON_FIELD_ERRORS: "nonField"}
CUSTOMER_TAKEN = next(c.violation_error_message for c in Customer._meta.constraints if c.name == "uniq_customer_name_ci")
SITE_TAKEN = next(c.violation_error_message for c in Site._meta.constraints if c.name == "uniq_site_name_per_customer_ci")
NOT_PERMITTED = "This account may not change customers and sites."
# Nothing is deleted along with a customer or a site: what still belongs to one, by the name the message gives it.
CUSTOMER_HOLDS = ("sites", "domains", "alertRules")
SITE_HOLDS = ("servers", "devices", "targets", "alertRules", "incidents")
HOLD_WORDS = {
    "sites": ("site", "sites"),
    "servers": ("server", "servers"),
    "devices": ("device", "devices"),
    "targets": ("network target", "network targets"),
    "domains": ("monitored domain", "monitored domains"),
    "alertRules": ("alert rule", "alert rules"),
    "incidents": ("incident", "incidents"),
}


# -- serialization -------------------------------------------------------------------------


def counted(model, lookup: str):
    """The rows of ``model`` whose ``lookup`` is the outer row, counted in a subquery of their own.

    One subquery per relation: joining them all at once would multiply the rows of one customer
    (its sites by its servers by its devices...) before counting them.
    """
    rows = model.objects.filter(**{lookup: OuterRef("pk")}).order_by().values(lookup).annotate(n=Count("pk")).values("n")
    return Coalesce(Subquery(rows, output_field=IntegerField()), Value(0))


def customer_counts(queryset):
    """Each customer with what belongs to it (through its sites, plus its domains), counted in the database."""
    return queryset.annotate(
        _sites=counted(Site, "customer"),
        _servers=counted(Server, "site__customer"),
        _devices=counted(Device, "site__customer"),
        _targets=counted(NetworkTarget, "site__customer"),
        _domains=counted(MonitoredDomain, "customer"),
    )


def site_counts(queryset):
    return queryset.annotate(
        _servers=counted(Server, "site"),
        _devices=counted(Device, "site"),
        _targets=counted(NetworkTarget, "site"),
        _customer_name=F("customer__name"),
    )


def serialize_customer(customer: Customer) -> dict:
    return {
        "id": str(customer.pk),
        "name": customer.name,
        "notes": customer.notes,
        "sites": customer._sites,
        "servers": customer._servers,
        "devices": customer._devices,
        "targets": customer._targets,
        "domains": customer._domains,
        "createdAt": iso(customer.created_at),
        "updatedAt": iso(customer.updated_at),
    }


def serialize_site(site: Site) -> dict:
    return {
        "id": str(site.pk),
        "customerId": str(site.customer_id),
        "customerName": site._customer_name,
        "name": site.name,
        "description": site.description,
        "servers": site._servers,
        "devices": site._devices,
        "targets": site._targets,
        "createdAt": iso(site.created_at),
        "updatedAt": iso(site.updated_at),
    }


def customer_values(customer: Customer) -> dict:
    return {"name": customer.name, "notes": customer.notes}


def site_values(site: Site) -> dict:
    return {"customerId": str(site.customer_id), "name": site.name, "description": site.description}


def ordering(sort: str, direction: str, *fields: str) -> list:
    descending = direction == "desc"
    if sort == "name":
        return [name_order(field, descending=descending) for field in fields] + ["pk"]
    return [F("created_at").desc() if descending else F("created_at").asc(), *[name_order(field) for field in fields], "pk"]


def paged(params: QueryParams, queryset, search_fields, order_fields, serialize, with_counts) -> dict:
    """One page of ``queryset`` (already visible), searched, sorted and counted."""
    now = timezone.now()
    words = params.search()
    sort = params.choice("sort", SORT_KEYS, "name")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)
    matching = apply_search(queryset, words, search_fields)
    total = matching.count()
    scope_total = queryset.count() if words else total
    items: list[dict] = []
    if page.offset < total:
        rows = with_counts(matching).order_by(*ordering(sort, direction, *order_fields))
        items = [serialize(row) for row in rows[page.offset : page.offset + page.size]]
    return {"generatedAt": iso(now), "items": items, "page": page.payload(total), "scopeTotal": scope_total}


def customer_payload(visibility, customer_id, now) -> dict:
    customer = visibility.customers().filter(pk=customer_id)
    row = customer_counts(customer).first()
    if row is None:
        raise ApiError(404, "not_found", "Not found.")
    sites = site_counts(visibility.sites().filter(customer_id=customer_id)).order_by(name_order("name"), "pk")
    return {"generatedAt": iso(now), "item": serialize_customer(row), "sites": [serialize_site(site) for site in sites]}


def site_payload(visibility, site_id, now) -> dict:
    row = site_counts(visibility.sites().filter(pk=site_id)).first()
    if row is None:
        raise ApiError(404, "not_found", "Not found.")
    return {"generatedAt": iso(now), "item": serialize_site(row)}


# -- parsing -------------------------------------------------------------------------------


def parse_customer(data: dict, *, partial: bool) -> dict:
    errors: dict[str, list[str]] = {}
    unknown_fields(data, CUSTOMER_FIELDS, errors)
    values: dict = {}
    if "name" in data or not partial:
        name = text(data, "name", limit=NAME_MAX_LENGTH, errors=errors).strip()
        if "name" not in errors and not name:
            errors["name"] = ["Required."]
        values["name"] = name
    if "notes" in data or not partial:
        values["notes"] = text(data, "notes", limit=NOTES_MAX_LENGTH, errors=errors, multiline=True)
    if errors:
        raise validation_error(errors)
    return values


def parse_site(data: dict, *, partial: bool) -> dict:
    errors: dict[str, list[str]] = {}
    unknown_fields(data, SITE_FIELDS, errors)
    values: dict = {}
    if "customerId" in data or not partial:
        if data.get("customerId") is None:
            errors["customerId"] = ["Required."]
        else:
            values["customer_id"] = reference(data, "customerId", errors=errors, model=Customer, label="customer")
    if "name" in data or not partial:
        name = text(data, "name", limit=NAME_MAX_LENGTH, errors=errors).strip()
        if "name" not in errors and not name:
            errors["name"] = ["Required."]
        values["name"] = name
    if "description" in data or not partial:
        values["description"] = text(data, "description", limit=NOTES_MAX_LENGTH, errors=errors, multiline=True)
    if errors:
        raise validation_error(errors)
    return values


def save(instance, *, taken: str, conflict: str, error_fields: dict) -> None:
    """Save (validated by the model) in a savepoint: a 409 for a taken name, a 400 for anything else wrong."""
    try:
        with transaction.atomic():
            instance.save()
    except ValidationError as error:
        fields = model_errors(error, error_fields)
        if any(taken in messages for messages in fields.values()):
            raise ApiError(409, conflict, taken) from None
        raise validation_error(fields) from None
    except IntegrityError:
        # The name taken by a row saved meanwhile (the constraint checks it again).
        raise ApiError(409, conflict, taken) from None


def in_use_message(what: str, name: str, held: dict[str, int]) -> str:
    parts = [f"{count} {HOLD_WORDS[key][0] if count == 1 else HOLD_WORDS[key][1]}" for key, count in held.items() if count]
    return f"The {what} “{name}” still has {', '.join(parts)}: move or delete them first. Nothing is deleted along with it."


def no_body(request) -> None:
    data = json_object(request, max_bytes=1024, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: a deletion has no options."] for name in sorted(data)})


# -- customers -----------------------------------------------------------------------------


@console_api(methods=("GET", "POST"))
def customer_collection(request):
    if request.method == "POST":
        return create_customer(request)
    params = QueryParams(request, CUSTOMER_LIST_PARAMS)
    visible = request.visibility.customers()
    return JsonResponse(paged(params, visible, ("name", "notes"), ("name",), serialize_customer, customer_counts))


@console_api(methods=("GET", "PATCH", "DELETE"))
def customer_item(request, customer_id: UUID):
    if request.method == "PATCH":
        return change_customer(request, customer_id)
    if request.method == "DELETE":
        return delete_customer(request, customer_id)
    QueryParams(request, ())
    return JsonResponse(customer_payload(request.visibility, customer_id, timezone.now()))


def create_customer(request):
    now = timezone.now()
    user = request.user
    require(may_add_customers(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    customer = Customer(**parse_customer(json_object(request, max_bytes=MAX_BODY_BYTES), partial=False))
    with transaction.atomic():
        save(customer, taken=CUSTOMER_TAKEN, conflict="customer_exists", error_fields=CUSTOMER_ERROR_FIELDS)
        audit.record(
            user,
            action="customer_created",
            target_type=audit.CUSTOMER,
            target_id=customer.pk,
            target_name=customer.name,
            changed=audit.changes({}, customer_values(customer)),
        )
    logger.info("Customer created (customer=%s, user_id=%s)", customer.pk, user.pk)
    response = JsonResponse(customer_payload(request.visibility, customer.pk, now), status=201)
    response["Location"] = f"{request.path}{customer.pk}/"
    return response


def change_customer(request, customer_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_change_customers(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values = parse_customer(json_object(request, max_bytes=MAX_BODY_BYTES), partial=True)
    with transaction.atomic():
        customer = Customer.objects.select_for_update(no_key=True).filter(pk__in=request.visibility.customers().values("pk"), pk=customer_id).first()
        if customer is None:
            raise ApiError(404, "not_found", "Not found.")
        before = customer_values(customer)
        for field, value in values.items():
            setattr(customer, field, value)
        if customer_values(customer) != before:
            save(customer, taken=CUSTOMER_TAKEN, conflict="customer_exists", error_fields=CUSTOMER_ERROR_FIELDS)
            audit.record(
                user,
                action="customer_changed",
                target_type=audit.CUSTOMER,
                target_id=customer.pk,
                target_name=customer.name,
                changed=audit.changes(before, customer_values(customer)),
            )
            logger.info("Customer changed (customer=%s, user_id=%s)", customer.pk, user.pk)
    return JsonResponse(customer_payload(request.visibility, customer.pk, now))


def delete_customer(request, customer_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_delete_customers(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    no_body(request)
    with transaction.atomic():
        customer = Customer.objects.select_for_update().filter(pk__in=request.visibility.customers().values("pk"), pk=customer_id).first()
        if customer is None:
            raise ApiError(404, "not_found", "Not found.")
        held = {
            "sites": Site.objects.filter(customer=customer).count(),
            "domains": MonitoredDomain.objects.filter(customer=customer).count(),
            "alertRules": AlertRule.objects.filter(customer=customer).count(),
        }
        if any(held.values()):
            raise ApiError(409, "customer_in_use", in_use_message("customer", customer.name, held))
        done = {"id": str(customer.pk), "name": customer.name}
        audit.record(
            user,
            action="customer_deleted",
            target_type=audit.CUSTOMER,
            target_id=customer.pk,
            target_name=customer.name,
            changed=audit.changes(customer_values(customer), {}),
        )
        try:
            customer.delete()
        except ProtectedError:
            # Something was added to it meanwhile: refused, as it would have been a moment earlier.
            raise ApiError(409, "customer_in_use", f"The customer “{customer.name}” is still in use: nothing was deleted.") from None
    logger.info("Customer deleted (customer=%s, user_id=%s)", done["id"], user.pk)
    return JsonResponse({"generatedAt": iso(now), "deleted": done})


# -- sites ---------------------------------------------------------------------------------


@console_api(methods=("GET", "POST"))
def site_collection(request):
    if request.method == "POST":
        return create_site(request)
    params = QueryParams(request, SITE_LIST_PARAMS)
    visibility = request.visibility
    visible = visibility.sites()
    customer_id = params.uuid("customer")
    if customer_id is not None:
        visibility.resolve_scope(customer_id, None)  # unknown or hidden: 404
        visible = visible.filter(customer_id=customer_id)
    return JsonResponse(
        paged(params, visible, ("name", "description", "customer__name"), ("customer__name", "name"), serialize_site, site_counts)
    )


@console_api(methods=("GET", "PATCH", "DELETE"))
def site_item(request, site_id: UUID):
    if request.method == "PATCH":
        return change_site(request, site_id)
    if request.method == "DELETE":
        return delete_site(request, site_id)
    QueryParams(request, ())
    return JsonResponse(site_payload(request.visibility, site_id, timezone.now()))


def create_site(request):
    now = timezone.now()
    user = request.user
    require(may_add_sites(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    site = Site(**parse_site(json_object(request, max_bytes=MAX_BODY_BYTES), partial=False))
    with transaction.atomic():
        save(site, taken=SITE_TAKEN, conflict="site_exists", error_fields=SITE_ERROR_FIELDS)
        audit.record(
            user,
            action="site_created",
            target_type=audit.SITE,
            target_id=site.pk,
            target_name=site.name,
            changed=audit.changes({}, site_values(site)),
        )
    logger.info("Site created (site=%s, customer=%s, user_id=%s)", site.pk, site.customer_id, user.pk)
    response = JsonResponse(site_payload(request.visibility, site.pk, now), status=201)
    response["Location"] = f"{request.path}{site.pk}/"
    return response


def change_site(request, site_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_change_sites(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values = parse_site(json_object(request, max_bytes=MAX_BODY_BYTES), partial=True)
    with transaction.atomic():
        site = Site.objects.select_for_update(no_key=True).filter(pk__in=request.visibility.sites().values("pk"), pk=site_id).first()
        if site is None:
            raise ApiError(404, "not_found", "Not found.")
        before = site_values(site)
        for field, value in values.items():
            setattr(site, field, value)
        if site_values(site) != before:
            save(site, taken=SITE_TAKEN, conflict="site_exists", error_fields=SITE_ERROR_FIELDS)
            audit.record(
                user,
                action="site_changed",
                target_type=audit.SITE,
                target_id=site.pk,
                target_name=site.name,
                changed=audit.changes(before, site_values(site)),
            )
            logger.info("Site changed (site=%s, customer=%s, user_id=%s)", site.pk, site.customer_id, user.pk)
    return JsonResponse(site_payload(request.visibility, site.pk, now))


def delete_site(request, site_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_delete_sites(user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    no_body(request)
    with transaction.atomic():
        site = Site.objects.select_for_update().filter(pk__in=request.visibility.sites().values("pk"), pk=site_id).first()
        if site is None:
            raise ApiError(404, "not_found", "Not found.")
        held = {
            "servers": Server.objects.filter(site=site).count(),
            "devices": Device.objects.filter(site=site).count(),
            "targets": NetworkTarget.objects.filter(site=site).count(),
            "alertRules": AlertRule.objects.filter(site=site).count(),
            "incidents": Incident.objects.filter(site=site).count(),
        }
        if any(held.values()):
            raise ApiError(409, "site_in_use", in_use_message("site", site.name, held))
        done = {"id": str(site.pk), "name": site.name}
        audit.record(
            user,
            action="site_deleted",
            target_type=audit.SITE,
            target_id=site.pk,
            target_name=site.name,
            changed=audit.changes(site_values(site), {}),
        )
        try:
            site.delete()
        except ProtectedError:
            raise ApiError(409, "site_in_use", f"The site “{site.name}” is still in use: nothing was deleted.") from None
    logger.info("Site deleted (site=%s, user_id=%s)", done["id"], user.pk)
    return JsonResponse({"generatedAt": iso(now), "deleted": done})
