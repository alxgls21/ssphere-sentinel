"""Users and their access from the console: ``GET/POST /users/``, ``GET/PATCH /users/<id>/``,
``POST /users/<id>/password/``, ``POST /users/<id>/unlock/``, and the signed-in account's own
password, ``PUT /account/password/``.

Who: administrators only (a superuser; ``apps.console.permissions.may_manage_users``), for
everything but the own password, which every console user changes for themselves. Whoever may
change accounts can give any account anything, so there is no lesser permission for it.

User::

    {"id": int, "username", "firstName", "lastName", "displayName", "email",
     "role": viewer | operator | editor | administrator | null, "allCustomers": bool, "active": bool,
     "lastLoginAt": str | null, "createdAt", "locked": bool, "lockedUntil": str | null, "self": bool,
     "customers": [{"id", "name"}], "sites": [{"id", "customerId", "customerName", "name"}]}

``role`` is what the account's permissions amount to (``apps.console.permissions``: the highest
role whose every permission it holds, directly or through its groups), null for an account that
may not use the console. ``allCustomers``: it sees every customer (an editor, an administrator,
or a viewer or operator granted so); otherwise ``customers`` and ``sites`` are what it sees.
``locked``: the sign-in throttle refuses it until ``lockedUntil`` (``apps.console.throttle``).
``self``: this is the signed-in account. Never a password, a hash, or anything about one.

List: ``{"generatedAt", "items", "page": {number, size, total, pages}, "counts": {"active", "inactive"},
"scopeTotal"}`` with ``q`` (words, every one in the user name, the names or the email), ``active``
(all | active | inactive), ``sort`` (username | joined | lastLogin), ``dir``, ``page``, ``pageSize``.
The detail is ``{"generatedAt", "item": User}``.

Create, ``POST /users/`` (``username``, ``password`` and ``role`` required)::

    {"username": str, "password": str, "email": str (""), "firstName": str (""), "lastName": str (""),
     "role": viewer | operator | editor | administrator, "active": bool (true),
     "allCustomers": bool (false; viewers and operators only: the other roles see every customer),
     "customerIds": [str] ([]), "siteIds": [str] ([])}

The administrator types the first password and tells the user; the user changes it from their
account (``PUT /account/password/``). The password is checked by the installation's validators
(``AUTH_PASSWORD_VALIDATORS``, as the admin and the first-run setup check it), stored hashed, and
never logged, recorded or answered. The user name is stored in Unicode NFKC, as the sign-in reads
it. A name another account has is a 409 ``user_exists``; invalid values a 400 ``validation_error``
with ``fields`` (unknown fields are refused there too); the body is at most 32 KiB. 201 with
``Location`` and the detail. Assigning a role sets exactly that role's permissions on the account
(``view_all_customers`` added for ``allCustomers``) and takes it out of every group; an
administrator is a superuser and may use the admin.

Change, ``PATCH /users/<id>/`` with any of the create fields but ``password``: only those sent
change. ``role`` and ``allCustomers`` reset the permissions as on creation (a role sent alone keeps
every customer if the account had it: send ``allCustomers`` with the role to decide); ``customerIds``
and ``siteIds`` replace the grants; ``active: false`` deactivates (the account's sessions end, its
sign-ins are refused, its grants and preferences stay), ``active: true`` reactivates. Refused:
deactivating or demoting your own account (409 ``own_account``), or the last active
administrator (409 ``last_administrator``), so no installation is left without one.

Password, ``POST /users/<id>/password/`` with ``{"password"}``: a new password for another
account (not your own: change that from your account), which ends that account's sessions.
Unlock, ``POST /users/<id>/unlock/`` with no body: forgets the account's failed sign-ins, as
``manage.py unlock_login`` does. Both answer 200 with the detail.

Own password, ``PUT /account/password/`` with ``{"currentPassword", "newPassword"}``: the current
one must be right (a wrong one counts as a failed sign-in of the account, under the sign-in
throttle: 429 ``too_many_attempts`` once locked), the new one passes the validators. 200
``{"generatedAt", "changedAt"}``; this session stays signed in, every other one of the account ends.

Every write is logged (``apps.console``) with the ids and recorded in the audit trail
(``apps.console.audit``) with the fields that changed: a password change is the action alone.
Accounts are never deleted from the console: the audit trail refers to them; deactivate instead.
"""

from __future__ import annotations

import logging
import unicodedata
from itertools import chain

from django.contrib.auth import get_user_model, update_session_auth_hash
from django.contrib.auth.models import Permission
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import NON_FIELD_ERRORS, ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import Count, F, Q
from django.http import JsonResponse
from django.utils import timezone

from apps.console import audit, throttle
from apps.console.access import VIEW_ALL_CUSTOMERS
from apps.console.fields import boolean, choice, model_errors, text, unknown_fields
from apps.console.http import ApiError, console_api, json_object, storable_text, validation_error
from apps.console.listing import apply_search, name_order
from apps.console.models import CustomerAccess, SiteAccess
from apps.console.params import PAGE_PARAMS, PageRequest, QueryParams, canonical_uuid
from apps.console.permissions import (
    ADMINISTRATOR,
    EDITOR,
    OPERATOR,
    ROLE_PERMISSIONS,
    ROLES,
    VIEWER,
    may_manage_users,
    require,
    role_of,
)
from apps.console.serializers import iso, iso_or_none
from apps.inventory.models import Customer, Site

logger = logging.getLogger("apps.console")

User = get_user_model()
USERNAME_MAX_LENGTH = User._meta.get_field("username").max_length
NAME_MAX_LENGTH = User._meta.get_field("first_name").max_length
EMAIL_MAX_LENGTH = User._meta.get_field("email").max_length
MAX_PASSWORD_LENGTH = 1024
MAX_GRANTS = 500
# The names, the email and up to MAX_GRANTS ids of each kind, each character escaped as JSON may.
MAX_BODY_BYTES = 32 * 1024
MAX_PASSWORD_BODY_BYTES = 4096
NOT_PERMITTED = "This account may not manage users."
USER_TAKEN = "A user with that username already exists."
ACTIVE_FILTERS = ("all", "active", "inactive")
SORT_KEYS = ("username", "joined", "lastLogin")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"username": "asc", "joined": "desc", "lastLogin": "desc"}
LIST_PARAMS = ("q", "active", "sort", "dir", *PAGE_PARAMS)
SEARCH_FIELDS = ("username", "first_name", "last_name", "email")
BODY_FIELDS = ("username", "password", "email", "firstName", "lastName", "role", "active", "allCustomers", "customerIds", "siteIds")
REQUIRED_ON_CREATE = ("username", "password", "role")
# Model field (as validation errors name it) -> body field.
ERROR_FIELDS = {
    "username": "username",
    "email": "email",
    "first_name": "firstName",
    "last_name": "lastName",
    NON_FIELD_ERRORS: "nonField",
}
# The roles whose scope is a choice; the others see every customer.
SCOPED_ROLES = (VIEWER, OPERATOR)


# -- reading -------------------------------------------------------------------------------


def held_permissions(user_ids: list[int]) -> dict[int, set[str]]:
    """``app.codename`` of every permission each account holds, directly or through its groups (two queries)."""
    held: dict[int, set[str]] = {user_id: set() for user_id in user_ids}
    direct = User.user_permissions.through.objects.filter(user_id__in=user_ids).values_list(
        "user_id", "permission__content_type__app_label", "permission__codename"
    )
    via_groups = User.groups.through.objects.filter(user_id__in=user_ids).values_list(
        "user_id", "group__permissions__content_type__app_label", "group__permissions__codename"
    )
    for user_id, app_label, codename in chain(direct, via_groups):
        if codename:  # a group without permissions joins as nothing
            held[user_id].add(f"{app_label}.{codename}")
    return held


def grants_of(user_ids: list[int]) -> tuple[dict[int, list[dict]], dict[int, list[dict]]]:
    """The customers and the sites each account is granted, named (two queries)."""
    customers: dict[int, list[dict]] = {user_id: [] for user_id in user_ids}
    sites: dict[int, list[dict]] = {user_id: [] for user_id in user_ids}
    rows = CustomerAccess.objects.filter(user_id__in=user_ids).order_by(name_order("customer__name"), "customer_id")
    for user_id, customer_id, name in rows.values_list("user_id", "customer_id", "customer__name"):
        customers[user_id].append({"id": str(customer_id), "name": name})
    rows = SiteAccess.objects.filter(user_id__in=user_ids).order_by(name_order("site__customer__name"), name_order("site__name"), "site_id")
    for user_id, site_id, name, customer_id, customer_name in rows.values_list(
        "user_id", "site_id", "site__name", "site__customer_id", "site__customer__name"
    ):
        sites[user_id].append({"id": str(site_id), "customerId": str(customer_id), "customerName": customer_name, "name": name})
    return customers, sites


def serialize_users(users: list, now, self_id: int) -> list[dict]:
    """The items of one page: permissions, grants and lockouts in a handful of queries."""
    ids = [user.pk for user in users]
    held = held_permissions(ids)
    customers, sites = grants_of(ids)
    locked = throttle.locked_until(ids, now)
    items = []
    for user in users:
        role = role_of(user.is_superuser, held[user.pk])
        items.append(
            {
                "id": user.pk,
                "username": user.get_username(),
                "firstName": user.first_name,
                "lastName": user.last_name,
                "displayName": user.get_full_name() or user.get_username(),
                "email": user.email,
                "role": role,
                "allCustomers": user.is_superuser or VIEW_ALL_CUSTOMERS in held[user.pk],
                "active": user.is_active,
                "lastLoginAt": iso_or_none(user.last_login),
                "createdAt": iso(user.date_joined),
                "locked": user.pk in locked,
                "lockedUntil": iso_or_none(locked.get(user.pk)),
                "self": user.pk == self_id,
                "customers": customers[user.pk],
                "sites": sites[user.pk],
            }
        )
    return items


def detail_payload(request, user_id: int, now) -> dict:
    user = User.objects.filter(pk=user_id).first()
    if user is None:
        raise ApiError(404, "not_found", "Not found.")
    (item,) = serialize_users([user], now, request.user.pk)
    return {"generatedAt": iso(now), "item": item}


def ordering(sort: str, direction: str) -> list:
    descending = direction == "desc"
    if sort == "username":
        return [name_order("username", descending=descending), "pk"]
    field = {"joined": "date_joined", "lastLogin": "last_login"}[sort]
    column = F(field).desc(nulls_last=True) if descending else F(field).asc(nulls_last=True)
    return [column, name_order("username"), "pk"]


@console_api(methods=("GET", "POST"))
def user_collection(request):
    if request.method == "POST":
        return create_user(request)
    now = timezone.now()
    require(may_manage_users(request.user, request.visibility), NOT_PERMITTED)
    params = QueryParams(request, LIST_PARAMS)
    words = params.search()
    active = params.choice("active", ACTIVE_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "username")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)
    every = User.objects.all()
    matching = apply_search(every, words, SEARCH_FIELDS)
    counts = {"active": 0, "inactive": 0}
    for row in matching.order_by().values("is_active").annotate(n=Count("pk")):
        counts["active" if row["is_active"] else "inactive"] = row["n"]
    scope_total = every.count() if words else sum(counts.values())
    total = sum(counts.values()) if active == "all" else counts[active]
    items: list[dict] = []
    if page.offset < total:
        rows = matching if active == "all" else matching.filter(is_active=active == "active")
        users = list(rows.order_by(*ordering(sort, direction))[page.offset : page.offset + page.size])
        items = serialize_users(users, now, request.user.pk)
    return JsonResponse(
        {"generatedAt": iso(now), "items": items, "page": page.payload(total), "counts": counts, "scopeTotal": scope_total}
    )


@console_api(methods=("GET", "PATCH"))
def user_item(request, user_id: int):
    if request.method == "PATCH":
        return change_user(request, user_id)
    now = timezone.now()
    require(may_manage_users(request.user, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    return JsonResponse(detail_payload(request, user_id, now))


# -- parsing -------------------------------------------------------------------------------


def id_list(data: dict, name: str, *, errors: dict, model, label: str) -> list | None:
    """Distinct ids of existing rows of ``model``, in the order given; ``None`` (and an error) for anything else."""
    value = data.get(name)
    if not isinstance(value, list) or len(value) > MAX_GRANTS:
        errors[name] = [f"Expected a list of at most {MAX_GRANTS} {label} ids."]
        return None
    ids = []
    for raw in value:
        parsed = canonical_uuid(raw)
        if parsed is None:
            errors[name] = [f"Expected a list of {label} ids."]
            return None
        if parsed not in ids:
            ids.append(parsed)
    if ids and model.objects.filter(pk__in=ids).count() != len(ids):
        errors[name] = [f"One of the {label}s does not exist."]
        return None
    return ids


def password_text(data: dict, name: str, errors: dict) -> str | None:
    """A password as text the hashers can take; its strength is checked against the account later."""
    value = data.get(name)
    if not storable_text(value) or not 1 <= len(value) <= MAX_PASSWORD_LENGTH:
        errors[name] = ["Required: text of at most 1024 characters."]
        return None
    return value


def parse_user(data: dict, *, creating: bool) -> dict:
    """What a body sets, by the body's names, or a 400 with what is wrong, field by field."""
    errors: dict[str, list[str]] = {}
    unknown_fields(data, BODY_FIELDS, errors)
    if creating:
        for name in REQUIRED_ON_CREATE:
            if name not in data:
                errors[name] = ["Required."]
    elif "password" in data:
        errors["password"] = ["A password is set from its own endpoint."]
    values: dict = {}
    for name in data:
        if name not in BODY_FIELDS or name in errors:
            continue
        if name == "username":
            # The spelling the sign-in looks up (Unicode NFKC), without the spaces around it.
            parsed = unicodedata.normalize("NFKC", text(data, name, limit=USERNAME_MAX_LENGTH, errors=errors).strip())
            if name not in errors and not parsed:
                errors[name] = ["Required."]
        elif name == "password":
            parsed = password_text(data, name, errors)
        elif name == "email":
            parsed = text(data, name, limit=EMAIL_MAX_LENGTH, errors=errors).strip()
        elif name in ("firstName", "lastName"):
            parsed = text(data, name, limit=NAME_MAX_LENGTH, errors=errors).strip()
        elif name == "role":
            parsed = choice(data, name, errors=errors, choices=ROLES)
        elif name in ("active", "allCustomers"):
            parsed = boolean(data, name, errors=errors)
        elif name == "customerIds":
            parsed = id_list(data, name, errors=errors, model=Customer, label="customer")
        else:
            parsed = id_list(data, name, errors=errors, model=Site, label="site")
        if name not in errors:
            values[name] = parsed
    if errors:
        raise validation_error(errors)
    return values


def account_problems(user, password: str | None) -> dict[str, list[str]]:
    """What the model and the password validators find wrong with an account (a taken name is a 409)."""
    fields: dict[str, list[str]] = {}
    try:
        user.full_clean(exclude=["password", "last_login", "date_joined"])
    except ValidationError as error:
        if any(problem.code == "unique" for problem in getattr(error, "error_dict", {}).get("username", [])):
            raise ApiError(409, "user_exists", USER_TAKEN) from None
        fields = model_errors(error, ERROR_FIELDS)
    if user.email and "email" not in fields:
        try:
            validate_email(user.email)
        except ValidationError as error:
            fields["email"] = list(error.messages)
    if password is not None:
        try:
            validate_password(password, user)
        except ValidationError as error:
            fields["password"] = list(error.messages)
    return fields


# -- writing -------------------------------------------------------------------------------


def permission_objects(names: set[str]) -> list[Permission]:
    """The ``Permission`` rows of ``app.codename`` names (every one exists: ``migrate`` creates them)."""
    wanted = {tuple(name.split(".", 1)) for name in names}
    found = {
        (permission.content_type.app_label, permission.codename): permission
        for permission in Permission.objects.filter(codename__in=[codename for _, codename in wanted]).select_related("content_type")
    }
    missing = wanted - found.keys()
    if missing:
        raise RuntimeError(f"permissions not installed: {sorted(missing)}")
    return [found[key] for key in wanted]


def set_role(user, role: str, all_customers: bool) -> None:
    """Exactly the role's permissions, directly on the account; no group adds to it."""
    names = set(ROLE_PERMISSIONS[role])
    if all_customers and role in SCOPED_ROLES:
        names.add(VIEW_ALL_CUSTOMERS)
    user.is_superuser = role == ADMINISTRATOR
    user.is_staff = role == ADMINISTRATOR
    user.save(update_fields=["is_superuser", "is_staff"])
    user.user_permissions.set(permission_objects(names))
    user.groups.clear()


def set_grants(user, customer_ids: list | None, site_ids: list | None) -> None:
    """Replace the grants of each kind that was sent; a kept grant keeps its date."""
    if customer_ids is not None:
        CustomerAccess.objects.filter(user=user).exclude(customer_id__in=customer_ids).delete()
        existing = set(CustomerAccess.objects.filter(user=user).values_list("customer_id", flat=True))
        CustomerAccess.objects.bulk_create([CustomerAccess(user=user, customer_id=pk) for pk in customer_ids if pk not in existing])
    if site_ids is not None:
        SiteAccess.objects.filter(user=user).exclude(site_id__in=site_ids).delete()
        existing = set(SiteAccess.objects.filter(user=user).values_list("site_id", flat=True))
        SiteAccess.objects.bulk_create([SiteAccess(user=user, site_id=pk) for pk in site_ids if pk not in existing])


def audit_values(user, held: set[str], customers: list, sites: list) -> dict:
    """The account by the names the API gives it, for the audit trail: never anything about its password."""
    return {
        "username": user.get_username(),
        "email": user.email,
        "firstName": user.first_name,
        "lastName": user.last_name,
        "role": role_of(user.is_superuser, held),
        "allCustomers": user.is_superuser or VIEW_ALL_CUSTOMERS in held,
        "active": user.is_active,
        "customerIds": sorted(str(pk) for pk in customers),
        "siteIds": sorted(str(pk) for pk in sites),
    }


def current_values(user) -> dict:
    held = held_permissions([user.pk])[user.pk]
    customers = CustomerAccess.objects.filter(user=user).values_list("customer_id", flat=True)
    sites = SiteAccess.objects.filter(user=user).values_list("site_id", flat=True)
    return audit_values(user, held, list(customers), list(sites))


def check_scope(values: dict, role: str | None, errors: dict) -> None:
    if values.get("allCustomers") is False and role in (EDITOR, ADMINISTRATOR):
        errors["allCustomers"] = ["Editors and administrators see every customer."]


def create_user(request):
    now = timezone.now()
    actor = request.user
    require(may_manage_users(actor, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values = parse_user(json_object(request, max_bytes=MAX_BODY_BYTES), creating=True)
    errors: dict[str, list[str]] = {}
    check_scope(values, values["role"], errors)
    if errors:
        raise validation_error(errors)
    user = User(
        username=values["username"],
        email=values.get("email", ""),
        first_name=values.get("firstName", ""),
        last_name=values.get("lastName", ""),
        is_active=values.get("active", True),
    )
    problems = account_problems(user, values["password"])
    if problems:
        raise validation_error(problems)
    user.set_password(values["password"])
    try:
        with transaction.atomic():
            user.save()
            set_role(user, values["role"], values.get("allCustomers", False))
            set_grants(user, values.get("customerIds", []), values.get("siteIds", []))
            audit.record(
                actor,
                action="user_created",
                target_type=audit.USER,
                target_id=user.pk,
                target_name=user.get_username(),
                changed=audit.changes({}, current_values(user)),
            )
    except IntegrityError:
        # The name taken by an account saved meanwhile (the constraint checks it again).
        raise ApiError(409, "user_exists", USER_TAKEN) from None
    logger.info("User created (user=%s, role=%s, by_user_id=%s)", user.pk, values["role"], actor.pk)
    response = JsonResponse(detail_payload(request, user.pk, now), status=201)
    response["Location"] = f"{request.path}{user.pk}/"
    return response


def locked_user(user_id: int):
    """The account, its row held until the end of the transaction; 404 when unknown."""
    user = User.objects.select_for_update().filter(pk=user_id).first()
    if user is None:
        raise ApiError(404, "not_found", "Not found.")
    return user


def guard_administrators(actor, target, *, deactivating: bool, demoting: bool) -> None:
    """Nobody locks themselves out, and no installation is left without an active administrator."""
    if not (deactivating or demoting):
        return
    if target.pk == actor.pk:
        raise ApiError(409, "own_account", "Your own account cannot be deactivated or demoted here: another administrator must do it.")
    if target.is_superuser and target.is_active:
        # Every administrator's row is held: two demotions at once cannot each see the other still there.
        administrators = list(User.objects.select_for_update().filter(is_superuser=True, is_active=True).values_list("pk", flat=True))
        if len(administrators) <= 1:
            raise ApiError(
                409,
                "last_administrator",
                "This is the last active administrator: make another account an administrator first.",
            )


def change_user(request, user_id: int):
    now = timezone.now()
    actor = request.user
    require(may_manage_users(actor, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    values = parse_user(json_object(request, max_bytes=MAX_BODY_BYTES), creating=False)
    try:
        with transaction.atomic():
            user = locked_user(user_id)
            before = current_values(user)
            role = values.get("role", before["role"])
            errors: dict[str, list[str]] = {}
            check_scope(values, role, errors)
            if "allCustomers" in values and "role" not in values and role is None:
                errors["allCustomers"] = ["Give the account a role first."]
            if errors:
                raise validation_error(errors)
            guard_administrators(
                actor,
                user,
                deactivating=values.get("active") is False and user.is_active,
                demoting="role" in values and user.is_superuser and values["role"] != ADMINISTRATOR,
            )
            for name, field in (("username", "username"), ("email", "email"), ("firstName", "first_name"), ("lastName", "last_name")):
                if name in values:
                    setattr(user, field, values[name])
            if "active" in values:
                user.is_active = values["active"]
            problems = account_problems(user, None)
            if problems:
                raise validation_error(problems)
            user.save()
            if ("role" in values or "allCustomers" in values) and role is not None:
                set_role(user, role, values.get("allCustomers", before["allCustomers"]))
            set_grants(user, values.get("customerIds"), values.get("siteIds"))
            after = current_values(user)
            diff = audit.changes(before, after)
            if diff:
                common = {"target_type": audit.USER, "target_id": user.pk, "target_name": user.get_username()}
                switched = diff.pop("active", None)
                if switched is not None:
                    audit.record(actor, action="user_activated" if switched["after"] else "user_deactivated", changed={"active": switched}, **common)
                if diff:
                    audit.record(actor, action="user_changed", changed=diff, **common)
                logger.info("User changed (user=%s, fields=%s, by_user_id=%s)", user.pk, ",".join(sorted(diff) + (["active"] if switched else [])), actor.pk)
    except IntegrityError:
        raise ApiError(409, "user_exists", USER_TAKEN) from None
    return JsonResponse(detail_payload(request, user.pk, now))


@console_api(methods=("POST",))
def reset_password(request, user_id: int):
    now = timezone.now()
    actor = request.user
    require(may_manage_users(actor, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    data = json_object(request, max_bytes=MAX_PASSWORD_BODY_BYTES)
    errors: dict[str, list[str]] = {}
    unknown_fields(data, ("password",), errors)
    password = password_text(data, "password", errors)
    if errors:
        raise validation_error(errors)
    with transaction.atomic():
        user = locked_user(user_id)
        if user.pk == actor.pk:
            raise ApiError(409, "own_account", "Change your own password from your account settings.")
        problems = account_problems(user, password)
        if problems:
            raise validation_error({"password": problems.get("password", ["The password is not valid for this account."])})
        user.set_password(password)
        user.save(update_fields=["password"])
        audit.record(actor, action="user_password_reset", target_type=audit.USER, target_id=user.pk, target_name=user.get_username())
    logger.info("User password reset (user=%s, by_user_id=%s)", user.pk, actor.pk)
    return JsonResponse(detail_payload(request, user.pk, now))


@console_api(methods=("POST",))
def unlock_user(request, user_id: int):
    now = timezone.now()
    actor = request.user
    require(may_manage_users(actor, request.visibility), NOT_PERMITTED)
    QueryParams(request, ())
    data = json_object(request, max_bytes=1024, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: an unlock has no options."] for name in sorted(data)})
    with transaction.atomic():
        user = locked_user(user_id)
        was_locked = user.pk in throttle.locked_until([user.pk], now)
        throttle.unlock(user.pk)
        audit.record(
            actor,
            action="user_unlocked",
            target_type=audit.USER,
            target_id=user.pk,
            target_name=user.get_username(),
            changed={"locked": {"before": was_locked, "after": False}},
        )
    logger.info("User unlocked (user=%s, was_locked=%s, by_user_id=%s)", user.pk, was_locked, actor.pk)
    return JsonResponse(detail_payload(request, user.pk, now))


@console_api(methods=("PUT",))
def account_password(request):
    now = timezone.now()
    user = request.user
    QueryParams(request, ())
    data = json_object(request, max_bytes=MAX_PASSWORD_BODY_BYTES)
    errors: dict[str, list[str]] = {}
    unknown_fields(data, ("currentPassword", "newPassword"), errors)
    current = password_text(data, "currentPassword", errors)
    new = password_text(data, "newPassword", errors)
    if errors:
        raise validation_error(errors)
    # A wrong current password is a guess at the account's password: it counts as a failed sign-in.
    key = throttle.throttle_key(user.get_username(), user.pk)
    if throttle.begin_attempt(key, now, user_id=user.pk) is not None:
        raise ApiError(429, "too_many_attempts", "Too many wrong passwords. Wait a while, then try again.")
    if not user.check_password(current):
        logger.warning("Own password change refused: wrong current password (user_id=%s)", user.pk)
        raise validation_error({"currentPassword": ["The current password is not right."]})
    throttle.clear(key)
    try:
        validate_password(new, user)
    except ValidationError as error:
        raise validation_error({"newPassword": list(error.messages)}) from None
    with transaction.atomic():
        user.set_password(new)
        user.save(update_fields=["password"])
        audit.record(user, action="user_password_changed", target_type=audit.USER, target_id=user.pk, target_name=user.get_username())
    update_session_auth_hash(request, user)  # this session goes on; every other one of the account ends
    logger.info("Own password changed (user_id=%s)", user.pk)
    return JsonResponse({"generatedAt": iso(now), "changedAt": iso(now)})
