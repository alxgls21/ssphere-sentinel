"""Monitored domains and their DNS verification: ``GET/POST /domains/``, ``GET /domains/<id>/``,
``POST /domains/<id>/verify/``, ``GET /domains/<id>/verifications/<vid>/``.

Who: every endpoint needs global visibility (``console.view_all_customers``, or a
superuser): the list names every customer's domains. Then ``web.view_monitoreddomain``
(or the permission to add or verify) to read, ``web.add_monitoreddomain`` to add,
``web.verify_monitoreddomain`` to ask for a verification. Otherwise 403. Domains are
not changed or deleted here.

A domain is monitored only once verified: its customer adds the record the detail
gives to the domain's DNS, and asks for a verification, which the domain verifier
answers from the domain's own name servers (the web process never asks the DNS).
The record's value is public DNS material, not a credential, and each customer has
its own for the same domain.

Domain::

    {"id", "name": ascii, "displayName": unicode, "customer": {"id", "name"},
     "status": pending | verified | degraded | suspended,
     "verifiedAt", "lastVerifiedAt", "lastCheckedAt": str | null,
     "lastOutcome": {"value", "label"} | null, "createdAt", "createdBy": str, "version": int}

The detail adds ``"record": {"type": "TXT", "name": "_ssphere-sentinel.<name>",
"value": "ssphere-verification=<token>"}`` and ``"latestVerification": Verification |
null``. ``status`` is ``verified`` from the first verification that found the record;
in this release nothing takes it back (``lastOutcome`` says what the latest found).

List::

    {"generatedAt", "items": [Domain], "page": {number, size, total, pages},
     "counts": {"pending", "verified", "degraded", "suspended"}, "scopeTotal": int}

Query parameters (anything else, or a repeated one, is a 400): ``q`` (every word in
the name, its Unicode form or the customer's name), ``status`` (all | a status),
``customer`` (an id), ``sort`` (name | customer | status | created), ``dir`` (asc |
desc), ``page``, ``pageSize``. ``counts`` are over every filter but ``status``;
``scopeTotal`` is every domain of the customer filter.

Add: ``POST`` with the CSRF token and ``{"customerId", "name"}``: the name as typed
(Unicode or ASCII, any case, a final dot or not). It is normalized (``apps.web.domains``):
an IP address, a single label, an invalid label, a public suffix (``co.uk``,
``github.io``), a name under no known suffix or a special-use name (``.local``,
``.test``) is a 400 ``validation_error`` (``name``); an unknown customer too
(``customerId``). 409 ``domain_exists`` when the customer has the domain already (in
any spelling), ``domain_limit`` beyond ``MAX_DOMAINS_PER_CUSTOMER``. 201 with
``Location`` and ``{"generatedAt", "item": DomainDetail}``.

Verify: ``POST`` with the CSRF token and no body (or ``{}``). 409
``verification_active`` while one is waiting or running; 429 ``rate_limited`` (one a
domain every 10 seconds; 20 a user every 10 minutes) and 503 ``queue_full``, with
``Retry-After``. 202 otherwise, with ``Location`` and::

    {"generatedAt", "item": Verification, "verifier": {"state": never_started | running | failed | stale}}

Verification::

    {"id", "domainId", "status": pending | running | done | expired,
     "outcome": {"value": verified | absent | propagation_pending | indeterminate, "label"} | null,
     "detail": {"value", "label"} | null, "requestedBy": str, "createdAt", "expiresAt",
     "startedAt", "finishedAt": str | null,
     "evidence": {"zone", "aliases": [str], "nameserverCount": int,
                  "nameservers": [{"name", "address", "result"}]} | null}

``verified``: every name server that answered has the record, and more than half of
the domain's name servers answered; ``absent``: as many say it is not there; ``propagation_pending``:
they disagree (a change still spreading: ask again later); ``indeterminate``: nothing
trustworthy either way (``detail`` says why: no answer in time, failures, too few
answers). A request no verifier took within ten minutes expires (``verifier.state``
tells whether one is running). ``GET`` reads one of the domain's verifications (one of
another domain is a 404). The frontend polls it.
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, F
from django.http import JsonResponse
from django.utils import timezone

from apps.console.http import ApiError, console_api, json_object, validation_error
from apps.console.listing import apply_search, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, PageRequest, QueryParams
from apps.console.permissions import may_add_domains, may_verify_domains, may_view_domains, require
from apps.console.serializers import iso
from apps.inventory.models import Customer
from apps.web import audit
from apps.web.domains import InvalidDomain, new_token, normalize, record_name, record_value
from apps.web.models import (
    DomainStatus,
    DomainVerification,
    MonitoredDomain,
    VerificationDetail,
    VerificationOutcome,
)
from apps.web.verification import Refused, expire_verifications, request_verification, verifier_state

logger = logging.getLogger("apps.console")

MAX_DOMAINS_PER_CUSTOMER = 500
MAX_BODY_BYTES = 4096
STATUS_FILTERS = ("all", *DomainStatus.values)
SORT_KEYS = ("name", "customer", "status", "created")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"name": "asc", "customer": "asc", "status": "asc", "created": "desc"}
LIST_PARAMS = ("q", "status", "customer", "sort", "dir", *PAGE_PARAMS)
SEARCH_FIELDS = ("name", "display_name", "customer__name")
FIELDS = (
    "id",
    "name",
    "display_name",
    "customer_id",
    "customer__name",
    "status",
    "verified_at",
    "last_verified_at",
    "last_checked_at",
    "last_outcome",
    "created_at",
    "created_by_name",
    "version",
)
CREATE_FIELDS = ("customerId", "name")
DOMAIN_UNIQUE = "uniq_web_domain_per_customer"


def _iso(value) -> str | None:
    return iso(value) if value is not None else None


def _choice(value: str, choices) -> dict | None:
    return {"value": value, "label": choices(value).label} if value else None


def serialize(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "displayName": row["display_name"],
        "customer": {"id": str(row["customer_id"]), "name": row["customer__name"]},
        "status": row["status"],
        "verifiedAt": _iso(row["verified_at"]),
        "lastVerifiedAt": _iso(row["last_verified_at"]),
        "lastCheckedAt": _iso(row["last_checked_at"]),
        "lastOutcome": _choice(row["last_outcome"], VerificationOutcome),
        "createdAt": iso(row["created_at"]),
        "createdBy": row["created_by_name"],
        "version": row["version"],
    }


def serialize_verification(row: DomainVerification) -> dict:
    return {
        "id": str(row.pk),
        "domainId": str(row.domain_id),
        "status": row.status,
        "outcome": _choice(row.outcome, VerificationOutcome),
        "detail": _choice(row.detail, VerificationDetail),
        "requestedBy": row.requested_by_name,
        "createdAt": iso(row.created_at),
        "expiresAt": iso(row.expires_at),
        "startedAt": _iso(row.started_at),
        "finishedAt": _iso(row.finished_at),
        "evidence": row.evidence or None,
    }


def visible_domains(request):
    """Every domain, for those who may see domains (all of which see every customer)."""
    require(may_view_domains(request.user, request.visibility), "This account may not see monitored domains.")
    return MonitoredDomain.objects.all()


def domain_or_404(queryset, domain_id):
    domain = queryset.filter(pk=domain_id).first()
    if domain is None:
        raise ApiError(404, "not_found", "Not found.")
    return domain


def ordering(sort: str, direction: str) -> list:
    descending = direction == "desc"
    tie = ["name", "pk"]
    if sort == "name":
        return [name_order("name", descending=descending), "pk"]
    if sort == "customer":
        return [name_order("customer__name", descending=descending), *tie]
    field = {"status": "status", "created": "created_at"}[sort]
    return [F(field).desc() if descending else F(field).asc(), *tie]


@console_api(methods=("GET", "POST"))
def domain_collection(request):
    if request.method == "POST":
        return create_domain(request)
    return domain_list(request)


def domain_list(request):
    now = timezone.now()
    every = visible_domains(request)
    params = QueryParams(request, LIST_PARAMS)
    words = params.search()
    status = params.choice("status", STATUS_FILTERS, "all")
    customer = params.uuid("customer")
    sort = params.choice("sort", SORT_KEYS, "name")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    if customer is not None:
        if not request.visibility.customers().filter(pk=customer).exists():
            raise ApiError(404, "not_found", "Not found.")
        every = every.filter(customer_id=customer)
    matching = apply_search(every, words, SEARCH_FIELDS)
    counts = dict.fromkeys(DomainStatus.values, 0)
    for row in matching.order_by().values("status").annotate(n=Count("pk")):
        counts[row["status"]] = row["n"]
    scope_total = every.count() if words else sum(counts.values())
    total = sum(counts.values()) if status == "all" else counts[status]

    items: list[dict] = []
    if page.offset < total:
        rows = matching if status == "all" else matching.filter(status=status)
        rows = rows.order_by(*ordering(sort, direction)).values(*FIELDS)[page.offset : page.offset + page.size]
        items = [serialize(row) for row in rows]
    return JsonResponse(page_envelope(now, items, page, total=total, counts=counts, scope_total=scope_total))


def detail_payload(domain_id, now) -> dict:
    row = MonitoredDomain.objects.filter(pk=domain_id).values(*FIELDS, "token").first()
    if row is None:
        raise ApiError(404, "not_found", "Not found.")
    expire_verifications(now, domain_id=domain_id)
    latest = DomainVerification.objects.filter(domain_id=domain_id).order_by("-created_at", "-pk").first()
    item = serialize(row)
    item["record"] = {"type": "TXT", "name": record_name(row["name"]), "value": record_value(row["token"])}
    item["latestVerification"] = serialize_verification(latest) if latest is not None else None
    return {"generatedAt": iso(now), "item": item}


@console_api()
def domain_item(request, domain_id: UUID):
    now = timezone.now()
    visible_domains(request)
    QueryParams(request, ())
    return JsonResponse(detail_payload(domain_id, now))


def parse_create(data: dict) -> tuple[UUID, str, str]:
    errors: dict[str, list[str]] = {}
    for name in sorted(set(data) - set(CREATE_FIELDS)):
        errors[name] = ["Unknown field."]
    customer_id = None
    raw = data.get("customerId")
    if raw is None:
        errors["customerId"] = ["Required."]
    else:
        try:
            parsed = UUID(raw) if isinstance(raw, str) and len(raw) <= 36 else None
        except ValueError:
            parsed = None
        if parsed is None or str(parsed) != raw.lower() or not Customer.objects.filter(pk=parsed).exists():
            errors["customerId"] = ["Expected the id of a customer."]
        else:
            customer_id = parsed
    ascii_name = display = ""
    if "name" not in data:
        errors["name"] = ["Required."]
    else:
        try:
            ascii_name, display = normalize(data["name"])
        except InvalidDomain as error:
            errors["name"] = [str(error)]
    if errors:
        raise validation_error(errors)
    return customer_id, ascii_name, display


def create_domain(request):
    now = timezone.now()
    user = request.user
    require(may_add_domains(user, request.visibility), "This account may not add monitored domains.")
    QueryParams(request, ())
    customer_id, ascii_name, display = parse_create(json_object(request, max_bytes=MAX_BODY_BYTES))
    try:
        with transaction.atomic():
            # One addition at a time per customer: the limit below and the insert see the same rows.
            if Customer.objects.select_for_update(no_key=True).filter(pk=customer_id).values_list("pk", flat=True).first() is None:
                raise validation_error({"customerId": ["Expected the id of a customer."]})  # deleted meanwhile
            existing = MonitoredDomain.objects.filter(customer_id=customer_id)
            if existing.filter(name=ascii_name).exists():
                raise ApiError(409, "domain_exists", "This customer already has this domain.")
            if existing.count() >= MAX_DOMAINS_PER_CUSTOMER:
                raise ApiError(409, "domain_limit", f"A customer has at most {MAX_DOMAINS_PER_CUSTOMER} domains.")
            domain = MonitoredDomain.objects.create(
                customer_id=customer_id,
                name=ascii_name,
                display_name=display,
                token=new_token(),
                token_created_at=now,
                created_by=user,
                created_by_name=user.get_username(),
                created_at=now,
                updated_at=now,
            )
            audit.domain_created(user, domain)
    except IntegrityError as error:
        # Added meanwhile by another request; anything else is not a conflict to explain.
        if getattr(getattr(error.__cause__, "diag", None), "constraint_name", None) != DOMAIN_UNIQUE:
            raise
        raise ApiError(409, "domain_exists", "This customer already has this domain.") from None
    logger.info("Domain added (domain=%s, customer=%s, user_id=%s)", domain.pk, customer_id, user.pk)
    response = JsonResponse(detail_payload(domain.pk, now), status=201)
    response["Location"] = f"{request.path}{domain.pk}/"
    return response


@console_api(methods=("POST",))
def verify_domain(request, domain_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_verify_domains(user, request.visibility), "This account may not verify domains.")
    QueryParams(request, ())
    data = json_object(request, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: a verification has no options."] for name in sorted(data)})
    try:
        with transaction.atomic():
            # One request at a time per domain and per user: the checks and the insert see the same rows.
            domain = domain_or_404(MonitoredDomain.objects.select_for_update(no_key=True), domain_id)
            list(get_user_model().objects.select_for_update(no_key=True).filter(pk=user.pk).values_list("pk", flat=True))
            row = request_verification(domain, user, now)
    except Refused as refused:
        headers = {"Retry-After": str(refused.retry_after)} if refused.retry_after is not None else None
        raise ApiError(refused.status, refused.code, refused.message, headers=headers) from None
    except IntegrityError:
        raise ApiError(409, "verification_active", "A verification of this domain is already waiting or running.") from None
    logger.info("Domain verification requested (verification=%s, domain=%s, user_id=%s)", row.pk, domain_id, user.pk)
    response = JsonResponse(
        {"generatedAt": iso(now), "item": serialize_verification(row), "verifier": {"state": verifier_state(now)}},
        status=202,
    )
    response["Location"] = f"{request.path.removesuffix('verify/')}verifications/{row.pk}/"
    return response


@console_api()
def verification_item(request, domain_id: UUID, verification_id: UUID):
    now = timezone.now()
    domain = domain_or_404(visible_domains(request), domain_id)
    QueryParams(request, ())
    expire_verifications(now, domain_id=domain.pk)
    row = DomainVerification.objects.filter(pk=verification_id, domain=domain).first()
    if row is None:
        raise ApiError(404, "not_found", "Not found.")
    return JsonResponse(
        {"generatedAt": iso(now), "item": serialize_verification(row), "verifier": {"state": verifier_state(now)}}
    )
