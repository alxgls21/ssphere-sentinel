"""Customer and site isolation, enforced in the database query.

Every console view that returns data gets its rows through a ``Visibility``
(``request.visibility`` inside a ``console_api`` view):

    rows = request.visibility.filter(Device.objects.all(), site_path="site")
    device = request.visibility.get(Device.objects.all(), pk)   # NotVisible if hidden

``filter`` adds ``WHERE site_id IN (<the user's visible sites>)``. The visible
sites are looked up once per request (one query on the small site table, cached
on the ``Visibility``) and passed as a literal list: PostgreSQL cannot
estimate a subquery built from grants, and measured badly with one (it scanned
the data table for a user who may see one site; with the literal list the same
query uses the data table's ``site_id`` index: 5 to 30 times faster per statement
on an estate of 50 thousand servers, more as the tables grow). A user whose visible sites are too many for a list (``MAX_LITERAL_SITES``)
gets the same condition as a subquery instead. A user who can see no site gets
``queryset.none()`` without touching the data table. Rows outside the user's
customers and sites are never read, counted, serialized or even
distinguishable from rows that do not exist: there is no "fetch everything,
then drop" step to forget. ``get`` is the detail-view counterpart.
``resolve_scope`` validates the ``customer`` and ``site`` query parameters
(strings are fine) against the same grants. ``NotVisible`` is answered as 404
by ``console_api``.

``site_path`` must be a chain of forward foreign keys from the model to
``Site`` (``"site"``, ``"device__site"``); anything else raises
``ImproperlyConfigured`` at the first call instead of silently returning
duplicates or the wrong rows.

Models need a ``site`` foreign key (``Server`` and ``NetworkTarget`` have a
nullable one; containers reach it through their server: ``site_path="server__site"``).
Every endpoint that returns tenant data starts from ``filter`` or ``get``.

Rules (see ``apps.console.models``):

* no ``use_console`` permission, or an inactive user: nothing is visible;
* ``view_all_customers`` (and superusers): everything, including objects that
  belong to no site;
* otherwise the union of the user's ``CustomerAccess`` (the customer's sites,
  also future ones) and ``SiteAccess`` rows. An object with no site is not
  visible: it is not assigned to anything the user was granted.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from uuid import UUID

from django.core.exceptions import FieldDoesNotExist, ImproperlyConfigured, ValidationError
from django.db.models import Model, Q, QuerySet

from apps.console.models import CustomerAccess, SiteAccess
from apps.inventory.models import Customer, Site

# Up to this many visible sites are filtered as a literal list; beyond it, as a subquery.
MAX_LITERAL_SITES = 2000

USE_CONSOLE = "console.use_console"
VIEW_ALL_CUSTOMERS = "console.view_all_customers"


class NotVisible(Exception):
    """A referenced customer, site or object does not exist or is not visible (answered as 404)."""


@lru_cache(maxsize=None)
def check_site_path(model: type[Model], site_path: str) -> None:
    """Raise ``ImproperlyConfigured`` unless ``site_path`` is forward foreign keys ending at ``Site``."""
    current = model
    for part in site_path.split("__"):
        try:
            field = current._meta.get_field(part)
        except FieldDoesNotExist:
            field = None
        if field is None or field.name != part or not field.concrete or not (field.many_to_one or field.one_to_one):
            raise ImproperlyConfigured(
                f"site_path {site_path!r} must be forward foreign keys from {model.__name__} to Site "
                f"(failed at {part!r})"
            )
        current = field.related_model
    if current is not Site:
        raise ImproperlyConfigured(f"site_path {site_path!r} on {model.__name__} does not end at Site")


@dataclass(frozen=True)
class Scope:
    """The customer and/or site a request narrows its data to, already authorized."""

    customer_id: UUID | None = None
    site_id: UUID | None = None


class Visibility:
    """What one user may see; build it with :meth:`for_user`."""

    def __init__(self, user_id: int | None, *, all_access: bool = False) -> None:
        self.user_id = user_id
        self.all_access = all_access
        self._restrictions: dict[tuple, tuple[str, object]] = {}

    @classmethod
    def nobody(cls) -> Visibility:
        return cls(None)

    @classmethod
    def for_user(cls, user) -> Visibility:
        if user is None or not user.is_authenticated or not user.is_active:
            return cls.nobody()
        if not user.has_perm(USE_CONSOLE):
            return cls.nobody()
        return cls(user.pk, all_access=user.has_perm(VIEW_ALL_CUSTOMERS))

    # -- organization --------------------------------------------------------

    def sites(self) -> QuerySet[Site]:
        """Sites the user may see."""
        if self.user_id is None:
            return Site.objects.none()
        if self.all_access:
            return Site.objects.all()
        return Site.objects.filter(
            Q(customer_id__in=self._customer_grants()) | Q(pk__in=self._site_grants())
        )

    def customers(self) -> QuerySet[Customer]:
        """Customers the user may see: granted ones, and those of granted sites.

        A site-only grant shows the customer's name (the UI labels the site
        with it) but none of the customer's other sites.
        """
        if self.user_id is None:
            return Customer.objects.none()
        if self.all_access:
            return Customer.objects.all()
        return Customer.objects.filter(
            Q(pk__in=self._customer_grants())
            | Q(pk__in=Site.objects.filter(pk__in=self._site_grants()).order_by().values("customer_id"))
        )

    # -- data ----------------------------------------------------------------

    def filter(self, queryset: QuerySet, *, site_path: str = "site", scope: Scope | None = None) -> QuerySet:
        """Restrict ``queryset`` to visible rows, then to ``scope``.

        ``site_path`` is the lookup from the model to its site: ``"site"`` for
        a model with a ``site`` foreign key, ``"device__site"`` for one that
        reaches it through a device, and so on. A ``scope`` is intersected with
        what the user may see, so it can never widen the result.
        """
        check_site_path(queryset.model, site_path)
        # The same misuse is an error for every user: it must not pass in tests
        # that run as an administrator and fail in production.
        if queryset.query.is_sliced or queryset.query.combinator:
            raise ImproperlyConfigured("filter() needs an unsliced queryset that is not a union/intersection: filter first, then slice")
        kind, value = self._restriction(scope)
        if kind == "none":
            return queryset.none()
        if kind == "all":
            return queryset
        return queryset.filter(**{f"{site_path}_id__in": value})

    def get(self, queryset: QuerySet, pk, *, site_path: str = "site"):
        """One visible row by primary key; :class:`NotVisible` if it does not exist or is hidden."""
        filtered = self.filter(queryset, site_path=site_path)  # a misuse raises here, as in filter()
        try:
            pk = queryset.model._meta.pk.to_python(pk)  # a key that cannot be this model's is simply not found
        except (ValidationError, ValueError, TypeError, OverflowError) as exc:
            raise NotVisible from exc
        try:
            return filtered.get(pk=pk)
        except queryset.model.DoesNotExist as exc:
            raise NotVisible from exc

    def resolve_scope(self, customer_id: UUID | str | None, site_id: UUID | str | None) -> Scope:
        """Check requested ``customer`` / ``site`` ids against the grants.

        The ids may be UUIDs or the strings of a query string. Raises
        :class:`NotVisible` for an id that is malformed (an empty string
        included), does not exist, is not visible, or a site that is not the
        customer's: all look the same.
        """
        customer_id = _parse_id(customer_id)
        site_id = _parse_id(site_id)
        if site_id is not None:
            site = self.sites().filter(pk=site_id).values("customer_id").first()
            if site is None or (customer_id is not None and site["customer_id"] != customer_id):
                raise NotVisible
        elif customer_id is not None and not self.customers().filter(pk=customer_id).exists():
            raise NotVisible
        return Scope(customer_id=customer_id, site_id=site_id)

    def _restriction(self, scope: Scope | None) -> tuple[str, object]:
        """``("all", None)``, ``("none", None)``, ``("ids", [..])`` or ``("subquery", qs)``; cached per scope."""
        if self.user_id is None:
            return "none", None
        customer_id = scope.customer_id if scope else None
        site_id = scope.site_id if scope else None
        key = (customer_id, site_id)
        if key not in self._restrictions:
            if self.all_access and customer_id is None and site_id is None:
                self._restrictions[key] = ("all", None)
            else:
                sites = self.sites().order_by()
                if customer_id is not None:
                    sites = sites.filter(customer_id=customer_id)
                if site_id is not None:
                    sites = sites.filter(pk=site_id)
                ids = list(sites.values_list("pk", flat=True)[: MAX_LITERAL_SITES + 1])
                if not ids:
                    self._restrictions[key] = ("none", None)
                elif len(ids) <= MAX_LITERAL_SITES:
                    self._restrictions[key] = ("ids", ids)
                else:
                    self._restrictions[key] = ("subquery", sites.values("pk"))
        return self._restrictions[key]

    # -- grants (subqueries in the database; the result is read once per request) --

    def _customer_grants(self) -> QuerySet:
        return CustomerAccess.objects.filter(user_id=self.user_id).order_by().values("customer_id")

    def _site_grants(self) -> QuerySet:
        return SiteAccess.objects.filter(user_id=self.user_id).order_by().values("site_id")


def _parse_id(value) -> UUID | None:
    """``None`` stays ``None``; a UUID or a UUID string is parsed; anything else is not visible."""
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    if isinstance(value, str) and value:
        try:
            return UUID(value)
        except ValueError:
            pass
    raise NotVisible
