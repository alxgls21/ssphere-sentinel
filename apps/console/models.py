"""Who may use the console, and which customers and sites they may see.

The console is the read API behind the web UI. It is authenticated with
Django sessions (never with agent tokens) and **authorized in the database
query**: every console queryset is filtered through ``apps.console.access``,
which turns these grants into SQL, so a row a user may not see is never
selected, serialized or counted.

Access is deny-by-default:

* ``use_console`` lets a user sign in to the console at all;
* without ``view_all_customers`` a user sees only what is granted below:
  a ``CustomerAccess`` row gives a customer with all its sites (including
  sites added later), a ``SiteAccess`` row gives one site;
* objects that belong to no site yet are visible to ``view_all_customers``
  users only.
"""

import uuid

from django.conf import settings
from django.db import models


class CustomerAccess(models.Model):
    """Grants a user one customer: all of its sites, now and in the future."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="console_customer_access",
        # Covered by the (user, customer) unique index.
        db_index=False,
    )
    customer = models.ForeignKey(
        "inventory.Customer",
        on_delete=models.CASCADE,
        related_name="console_access",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "customer access"
        verbose_name_plural = "customer access"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "customer"], name="uniq_console_customer_access"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user} -> {self.customer}"


class ConsoleAccess(CustomerAccess):
    """Carrier of the console permissions; has no table and no data of its own.

    A proxy model, so that ``dumpdata``, fixtures and every other tool that
    walks all models handle it (an unmanaged model without a table breaks
    them). Permission names stay within 50 characters: ``auth_permission.name``
    is ``varchar(50)`` in the oldest auth migrations.
    """

    class Meta:
        proxy = True
        default_permissions = ()
        permissions = [
            ("use_console", "Can sign in to the monitoring console"),
            ("view_all_customers", "Can see all customers and unassigned objects"),
            ("view_system_status", "Can see the system status in the console"),
        ]


class SiteAccess(models.Model):
    """Grants a user a single site (not the rest of its customer)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="console_site_access",
        # Covered by the (user, site) unique index.
        db_index=False,
    )
    site = models.ForeignKey(
        "inventory.Site",
        on_delete=models.CASCADE,
        related_name="console_access",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "site access"
        verbose_name_plural = "site access"
        constraints = [
            models.UniqueConstraint(fields=["user", "site"], name="uniq_console_site_access"),
        ]

    def __str__(self) -> str:
        return f"{self.user} -> {self.site}"


class LoginThrottle(models.Model):
    """Failed-login counter that throttles password guessing.

    One row per account (``u:<user id>``), or, for a user name that does not
    exist, per hash bucket (``x:<bucket>``): the table stays bounded however
    many random names are tried, and a locked bucket reveals nothing about
    which names exist. Attempts are counted *before* the password is checked
    and cleared on success, so parallel guesses cannot exceed the limit.
    """

    id = models.BigAutoField(primary_key=True)
    key = models.CharField(max_length=32, unique=True)
    # The account, for an existing user name (shown in the admin; the row goes
    # with the account). Null for the shared buckets of names that do not exist.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="+",
    )
    attempts = models.PositiveSmallIntegerField(default=0)
    window_started_at = models.DateTimeField()
    locked_until = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True, db_index=True)

    class Meta:
        verbose_name = "login throttle"
        verbose_name_plural = "login throttles"

    def __str__(self) -> str:
        return self.key
