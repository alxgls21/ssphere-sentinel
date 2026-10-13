"""Default groups, the permission model and the admin pages."""

import io
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth.models import Group, Permission
from django.core.management import call_command
from django.db import connection
from django.test import TestCase
from django.urls import reverse

from apps.console.groups import VIEWERS, VIEWERS_ALL, ensure_console_groups
from apps.console.models import CustomerAccess, LoginThrottle, SiteAccess
from apps.console.tests.helpers import Org, make_user, permission
from django.apps import apps as django_apps


def first_install():
    """The ``plan`` post_migrate receives in the run that applies the console's initial migration."""
    return [(SimpleNamespace(app_label="console", name="0001_initial_console"), False)]


class DefaultGroupTests(TestCase):
    def setUp(self):
        self.config = django_apps.get_app_config("console")

    def codenames(self, name):
        return sorted(Group.objects.get(name=name).permissions.values_list("codename", flat=True))

    def seed(self, plan="installing run"):
        ensure_console_groups(self.config, plan=first_install() if plan == "installing run" else plan)

    def test_the_groups_exist_after_migrating_with_the_right_permissions(self):
        self.assertEqual(self.codenames(VIEWERS), ["use_console"])
        self.assertEqual(self.codenames(VIEWERS_ALL), ["use_console", "view_all_customers"])

    def test_membership_in_a_group_grants_the_permission_but_no_data(self):
        user = make_user("member", console=False)
        user.groups.add(Group.objects.get(name=VIEWERS))
        user = type(user).objects.get(pk=user.pk)
        self.assertTrue(user.has_perm("console.use_console"))
        self.assertFalse(user.has_perm("console.view_all_customers"))

    def test_later_migrations_never_touch_the_groups(self):
        # Every container start runs migrate; its plan has no console migration in it.
        everyone = Group.objects.get(name=VIEWERS_ALL)
        everyone.permissions.clear()  # revoked on purpose, members kept
        Group.objects.filter(name=VIEWERS).update(name="Executives")  # renamed
        extra = Group.objects.create(name="Mine")
        extra.permissions.add(permission("use_console"))
        for plan in (None, [], [(SimpleNamespace(app_label="snmp", name="0002_x"), False)]):
            self.seed(plan)
        self.assertEqual(self.codenames(VIEWERS_ALL), [])
        self.assertFalse(Group.objects.filter(name=VIEWERS).exists())
        self.assertEqual(self.codenames("Mine"), ["use_console"])
        self.assertEqual(Group.objects.filter(name="Executives").count(), 1)

    def test_deleting_every_group_is_not_undone_by_a_later_migrate(self):
        Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).delete()
        self.seed([])
        self.assertFalse(Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).exists())

    def test_reversing_the_installation_seeds_nothing(self):
        Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).delete()
        self.seed([(SimpleNamespace(app_label="console", name="0001_initial_console"), True)])
        self.assertFalse(Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).exists())

    def test_the_installing_run_seeds_but_never_modifies_a_group_that_already_exists(self):
        Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).delete()
        custom = Group.objects.create(name=VIEWERS)  # an administrator's group with a default name
        custom.permissions.add(Permission.objects.get(codename="view_user"))
        self.seed()
        self.assertEqual(self.codenames(VIEWERS), ["view_user"])  # untouched
        self.assertEqual(self.codenames(VIEWERS_ALL), ["use_console", "view_all_customers"])  # the other one is created
        self.seed()  # and doing it again changes nothing
        self.assertEqual(Group.objects.filter(name=VIEWERS).count(), 1)

    def test_a_failure_halfway_leaves_no_group_behind(self):
        from django.db.models.query import QuerySet

        Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).delete()
        real, calls = QuerySet.get_or_create, []

        def second_group_fails(queryset, *args, **kwargs):
            calls.append(kwargs)
            if len(calls) == 2:
                raise RuntimeError("the database went away")
            return real(queryset, *args, **kwargs)

        with patch.object(QuerySet, "get_or_create", second_group_fails):
            with self.assertRaises(RuntimeError):
                self.seed()
        self.assertEqual(len(calls), 2)
        self.assertFalse(Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).exists())  # created and filled together, or not at all

    def test_a_group_is_never_created_without_its_permissions(self):
        Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).delete()
        Permission.objects.filter(content_type__app_label="console", codename="view_all_customers").delete()
        # The permission rows cannot be (re)created: nothing is half-created.
        with patch("apps.console.groups.create_permissions"), patch("apps.console.groups.create_contenttypes"):
            self.seed()
        self.assertFalse(Group.objects.filter(name__in=(VIEWERS, VIEWERS_ALL)).exists())

    def test_a_migration_state_without_auth_is_a_quiet_no_op(self):
        from django.apps.registry import Apps

        ensure_console_groups(self.config, apps=Apps([]), plan=first_install())

    def test_permission_names_fit_the_oldest_auth_schema(self):
        for perm in Permission.objects.filter(content_type__app_label="console"):
            self.assertLessEqual(len(perm.name), 50, perm.name)

    def test_the_permissions_exist_exactly_once(self):
        self.assertEqual(Permission.objects.filter(content_type__app_label="console", codename="use_console").count(), 1)


class DumpDataTests(TestCase):
    def test_dumpdata_works_with_the_console_app(self):
        make_user("alice")
        out = io.StringIO()
        call_command("dumpdata", "console", "auth.permission", stdout=out)
        self.assertIn("auth.permission", out.getvalue())
        self.assertNotIn("consoleaccess", out.getvalue().replace("use_console", ""))
        call_command("dumpdata", stdout=io.StringIO())  # everything, as a backup job would

    def test_the_permission_carrier_has_no_table_and_no_rows_of_its_own(self):
        from apps.console.models import ConsoleAccess

        self.assertTrue(ConsoleAccess._meta.proxy)
        self.assertNotIn("console_consoleaccess", connection.introspection.table_names())


class AdminTests(TestCase):
    def setUp(self):
        self.org = Org()
        self.root = make_user("root", superuser=True)
        self.client.force_login(self.root)

    def test_the_admin_pages_load(self):
        make_user("alice", customers=[self.org.acme], sites=[self.org.globex_plant])
        LoginThrottle.objects.create(key="u:1", window_started_at=self.org.acme.created_at)
        for model in ("customeraccess", "siteaccess", "loginthrottle"):
            for view in ("changelist", "add"):
                url = reverse(f"admin:console_{model}_{view}")
                response = self.client.get(url)
                if model == "loginthrottle" and view == "add":
                    self.assertEqual(response.status_code, 403)
                else:
                    self.assertEqual(response.status_code, 200, url)
        self.assertContains(self.client.get(reverse("admin:console_customeraccess_changelist")), "alice")

    def test_the_inventory_admins_used_by_the_autocomplete_have_a_total_order(self):
        from django.contrib import admin as django_admin

        from apps.inventory.models import Customer, Site

        for model in (Customer, Site):
            ordering = django_admin.site._registry[model].ordering
            self.assertEqual(ordering[-1], "pk", model.__name__)  # ties are broken, so paging cannot repeat or skip rows

    def test_a_user_manager_can_delete_users_who_have_throttle_rows(self):
        from django.contrib.auth import get_user_model
        from django.contrib.auth.models import Permission as P

        manager = make_user("manager", console=False, is_staff=True)
        manager.user_permissions.add(P.objects.get(codename="delete_user"), P.objects.get(codename="view_user"))
        target = make_user("target")
        LoginThrottle.objects.create(key=f"u:{target.pk}", user=target, attempts=2, window_started_at=self.org.acme.created_at)
        self.client.force_login(manager)
        url = reverse("admin:auth_user_delete", args=[target.pk])
        self.assertEqual(self.client.get(url).status_code, 200)  # not "you do not have permission to delete ... login throttle"
        self.client.post(url, {"post": "yes"})
        self.assertFalse(get_user_model().objects.filter(pk=target.pk).exists())
        self.assertFalse(LoginThrottle.objects.filter(key=f"u:{target.pk}").exists())

    def test_the_throttle_list_names_the_account(self):
        user = make_user("alice")
        LoginThrottle.objects.create(key=f"u:{user.pk}", user=user, attempts=5, window_started_at=self.org.acme.created_at)
        LoginThrottle.objects.create(key="x:12", attempts=5, window_started_at=self.org.acme.created_at)
        response = self.client.get(reverse("admin:console_loginthrottle_changelist"))
        self.assertContains(response, "alice")
        self.assertContains(response, "unknown names")
        self.assertContains(self.client.get(reverse("admin:console_loginthrottle_changelist") + "?q=alice"), "alice")

    def test_grants_are_unique_per_user_and_customer(self):
        from django.db import IntegrityError, transaction

        user = make_user("alice", customers=[self.org.acme])
        with self.assertRaises(IntegrityError), transaction.atomic():
            CustomerAccess.objects.create(user=user, customer=self.org.acme)
        SiteAccess.objects.create(user=user, site=self.org.acme_hq)
        with self.assertRaises(IntegrityError), transaction.atomic():
            SiteAccess.objects.create(user=user, site=self.org.acme_hq)

    def test_deleting_a_user_removes_their_grants(self):
        user = make_user("alice", customers=[self.org.acme], sites=[self.org.acme_hq])
        user.delete()
        self.assertEqual((CustomerAccess.objects.count(), SiteAccess.objects.count()), (0, 0))

    def test_throttle_rows_are_read_only_but_can_be_deleted_to_unlock(self):
        row = LoginThrottle.objects.create(key="u:5", attempts=5, window_started_at=self.org.acme.created_at)
        url = reverse("admin:console_loginthrottle_change", args=[row.pk])
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.post(url, {"attempts": 0}).status_code, 403)
        self.client.post(reverse("admin:console_loginthrottle_delete", args=[row.pk]), {"post": "yes"})
        self.assertFalse(LoginThrottle.objects.exists())
