"""Default permission groups, seeded once so access is easy to grant."""

from __future__ import annotations

from django.contrib.auth.management import create_permissions
from django.contrib.contenttypes.management import create_contenttypes
from django.db import router, transaction

VIEWERS = "Console viewers (assigned customers)"
VIEWERS_ALL = "Console viewers (all customers)"
CODENAMES = ("use_console", "view_all_customers")

_GROUPS = {
    VIEWERS: ("use_console",),
    VIEWERS_ALL: ("use_console", "view_all_customers"),
}


INITIAL_MIGRATION = ("console", "0001_initial_console")


def ensure_console_groups(sender, using="default", apps=None, plan=None, **kwargs) -> None:
    """Seed the two default groups (post_migrate), in the run that applies the console's first migration.

    "Once" is tied to something that happens once: ``plan`` (what this
    ``migrate`` applied) contains the console's initial migration only in the
    run that installs the app. Every later migrate (each container start runs
    one) does nothing here, so an administrator who renames, empties, deletes
    or re-fills the defaults, or builds their own groups, finds them as they
    left them. A group that already exists under a default name is not
    modified. Both groups are created and filled in one transaction, and only
    when both permissions exist. If the auth tables are not part of that run
    (a partial ``migrate``), nothing is created: add the groups in the admin.
    """
    if not any(
        (migration.app_label, migration.name) == INITIAL_MIGRATION and not backwards
        for migration, backwards in (plan or ())
    ):
        return

    from django.apps import apps as global_apps

    registry = apps or global_apps
    try:
        Group = registry.get_model("auth", "Group")
        Permission = registry.get_model("auth", "Permission")
    except LookupError:  # auth is not part of this (partial) migration
        return
    if not router.allow_migrate_model(using, Group):
        return
    # Both are idempotent and return quietly when their apps are not migrated;
    # running them here removes any dependence on the order in which
    # post_migrate receivers were connected.
    create_contenttypes(sender, apps=registry, using=using, verbosity=0)
    create_permissions(sender, apps=registry, using=using, verbosity=0)
    permissions = {
        permission.codename: permission
        for permission in Permission.objects.using(using).filter(
            content_type__app_label="console", codename__in=CODENAMES
        )
    }
    if set(permissions) != set(CODENAMES):
        return
    with transaction.atomic(using=using):
        for name, codenames in _GROUPS.items():
            group, created = Group.objects.using(using).get_or_create(name=name)
            if created:  # never modify a group that is already there
                group.permissions.set([permissions[codename] for codename in codenames])
