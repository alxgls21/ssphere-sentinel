"""Users and their access from the console (``apps.console.users``): administrators only, the roles and what they
amount to, the grants, passwords that are set and never answered, the lockout, the guards that keep an
installation with an active administrator, the signed-in account's own password, and the audit trail."""

from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.db import transaction
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from apps.console import throttle
from apps.console.access import USE_CONSOLE, VIEW_ALL_CUSTOMERS
from apps.console.http import ApiError
from apps.console.models import AuditEntry, CustomerAccess, LoginThrottle, SiteAccess
from apps.console.permissions import ADMINISTRATOR, EDITOR, OPERATOR, ROLE_PERMISSIONS, VIEWER, role_of
from apps.console.tests.helpers import PASSWORD, PINNED, API, grant, make_admin, make_editor, make_user, send, signed_in_client
from apps.console.users import guard_administrators
from apps.inventory.models import Customer, Site

USERS = API + "users/"
ACCOUNT_PASSWORD = API + "account/password/"
LOGIN = API + "auth/login/"
SESSION = API + "session/"
GOOD_PASSWORD = "a-long-and-unusual-passphrase-41"
OTHER_PASSWORD = "another-unusual-passphrase-77"
USER_KEYS = {
    "id", "username", "firstName", "lastName", "displayName", "email", "role", "allCustomers", "active", "lastLoginAt",
    "createdAt", "locked", "lockedUntil", "self", "customers", "sites",
}
THROTTLE = override_settings(SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS=3, SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS=900)

User = get_user_model()


def sign_in(username: str, password: str):
    client = Client(raise_request_exception=False)
    return client, client.post(LOGIN, json.dumps({"username": username, "password": password}), content_type="application/json")


def held(user) -> set[str]:
    return {f"{app}.{codename}" for app, codename in Permission.objects.filter(user=user).values_list("content_type__app_label", "codename")}


@PINNED
@THROTTLE
class UserTestCase(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.admin = make_admin()
        self.client_ = signed_in_client(self.admin)

    def audit(self, action):
        return list(AuditEntry.objects.filter(action=action).order_by("pk"))

    def path(self, user, suffix=""):
        return f"{USERS}{user.pk}/{suffix}"


class PermissionTests(UserTestCase):
    def setUp(self):
        super().setUp()
        self.viewer = make_user("viewer", customers=[self.acme])

    def writes(self, client: Client):
        return (
            send(client, "post", USERS, {"username": "new", "password": GOOD_PASSWORD, "role": "viewer"}),
            send(client, "patch", self.path(self.viewer), {"role": "administrator"}),
            send(client, "post", self.path(self.viewer, "password/"), {"password": GOOD_PASSWORD}),
            send(client, "post", self.path(self.viewer, "unlock/")),
        )

    def assert_refused(self, client, status):
        self.assertEqual(client.get(USERS).status_code, status)
        self.assertEqual(client.get(self.path(self.viewer)).status_code, status)
        for response in self.writes(client):
            self.assertEqual(response.status_code, status, response.content)
        self.assertFalse(User.objects.filter(username="new").exists())
        viewer = User.objects.get(pk=self.viewer.pk)
        self.assertEqual((viewer.is_superuser, viewer.check_password(PASSWORD)), (False, True))
        self.assertFalse(AuditEntry.objects.exists())

    def test_anonymous_requests_are_refused(self):
        self.assert_refused(Client(), 401)

    def test_nobody_but_an_administrator_manages_accounts(self):
        # An editor configures everything else, and the permissions of the admin's user model do not count: there is no
        # lesser permission than being an administrator, since whoever changes accounts can give any account anything.
        editor = make_editor()
        self.assert_refused(signed_in_client(editor), 403)
        self.assertFalse(signed_in_client(editor).get(SESSION).json()["capabilities"]["manageUsers"])
        staff = grant(make_user("staff", all_customers=True, is_staff=True), "auth.add_user", "auth.change_user", "auth.delete_user", "auth.view_user")
        self.assert_refused(signed_in_client(staff), 403)
        inactive_admin = make_admin("former", active=False)
        self.assert_refused(signed_in_client(inactive_admin), 401)
        self.assertTrue(self.client_.get(SESSION).json()["capabilities"]["manageUsers"])

    def test_nobody_grants_themselves_anything(self):
        # Neither a role, nor a customer, nor the superuser flag: every way of writing an account is refused.
        for user in (make_user("plain", customers=[self.acme]), make_editor("editor-2")):
            with self.subTest(user=user.username):
                client = signed_in_client(user)
                for body in (
                    {"role": "administrator"}, {"allCustomers": True}, {"customerIds": [str(self.globex.pk)]},
                    {"siteIds": [str(self.plant.pk)]}, {"active": True},
                ):
                    self.assertEqual(send(client, "patch", f"{USERS}{user.pk}/", body).status_code, 403)
                self.assertEqual(send(client, "post", USERS, {"username": "helper", "password": GOOD_PASSWORD, "role": "administrator"}).status_code, 403)
                self.assertEqual(send(client, "post", f"{USERS}{user.pk}/password/", {"password": GOOD_PASSWORD}).status_code, 403)
                refreshed = User.objects.get(pk=user.pk)
                self.assertFalse(refreshed.is_superuser)
                self.assertEqual(set(CustomerAccess.objects.filter(user=user).values_list("customer_id", flat=True)), {self.acme.pk} if user.username == "plain" else set())
                self.assertFalse(SiteAccess.objects.filter(user=user).exists())
        self.assertFalse(User.objects.filter(username="helper").exists())
        self.assertFalse(AuditEntry.objects.exists())

    def test_the_refusal_names_the_permission(self):
        response = signed_in_client(make_editor()).get(USERS)
        self.assertEqual(response.json()["error"], {"code": "forbidden", "message": "This account may not manage users."})

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.admin, enforce_csrf=True)
        for response in self.writes(client):
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        self.assertEqual(send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": PASSWORD, "newPassword": GOOD_PASSWORD}).json()["error"]["code"], "csrf_failed")
        token = client.get(SESSION).json()["csrfToken"]
        self.assertEqual(send(client, "post", self.path(self.viewer, "unlock/"), HTTP_X_CSRFTOKEN=token).status_code, 200)

    def test_only_the_documented_methods(self):
        self.assertEqual(self.client_.put(USERS, "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.delete(self.path(self.viewer)).status_code, 405)  # accounts are deactivated, never deleted
        self.assertEqual(self.client_.get(self.path(self.viewer, "password/")).status_code, 405)
        self.assertEqual(self.client_.get(ACCOUNT_PASSWORD).status_code, 405)
        self.assertTrue(User.objects.filter(pk=self.viewer.pk).exists())


class ReadTests(UserTestCase):
    def test_every_account_is_listed_with_its_role_grants_and_lockout_and_never_a_password(self):
        viewer = make_user("viewer", customers=[self.acme], sites=[self.plant], first_name="Vera", last_name="Viewer", email="vera@example.com")
        operator = grant(make_user("operator", all_customers=True), "alerts.acknowledge_incident", "alerts.send_test_email")
        editor = make_editor()
        nobody = make_user("nobody", console=False, active=False)
        group = Group.objects.create(name="editors")
        group.permissions.set(Permission.objects.filter(codename__in=[name.split(".")[1] for name in ROLE_PERMISSIONS[EDITOR]]))
        grouped = make_user("grouped", console=False)
        grouped.groups.add(group)
        now = timezone.now()
        for _ in range(4):
            throttle.begin_attempt(throttle.throttle_key("viewer", viewer.pk), now, user_id=viewer.pk)
        body = self.client_.get(USERS).json()
        self.assertEqual(set(body), {"generatedAt", "items", "page", "counts", "scopeTotal"})
        self.assertEqual(body["counts"], {"active": 5, "inactive": 1})
        by_name = {item["username"]: item for item in body["items"]}
        self.assertEqual(list(by_name), ["admin", "editor", "grouped", "nobody", "operator", "viewer"])
        self.assertEqual(set(by_name["viewer"]), USER_KEYS)
        item = by_name["viewer"]
        self.assertEqual((item["role"], item["allCustomers"], item["active"], item["displayName"], item["email"]), ("viewer", False, True, "Vera Viewer", "vera@example.com"))
        self.assertEqual(item["customers"], [{"id": str(self.acme.pk), "name": "Acme"}])
        self.assertEqual(item["sites"], [{"id": str(self.plant.pk), "customerId": str(self.globex.pk), "customerName": "Globex", "name": "Plant"}])
        self.assertEqual((item["locked"], item["lockedUntil"] is not None, item["self"], item["lastLoginAt"]), (True, True, False, None))
        self.assertEqual((by_name["operator"]["role"], by_name["operator"]["allCustomers"]), ("operator", True))
        self.assertEqual((by_name["editor"]["role"], by_name["editor"]["allCustomers"]), ("editor", True))
        self.assertEqual((by_name["grouped"]["role"], by_name["grouped"]["allCustomers"]), ("editor", True))  # through its group
        self.assertEqual((by_name["admin"]["role"], by_name["admin"]["self"], by_name["admin"]["locked"]), ("administrator", True, False))
        self.assertEqual((by_name["nobody"]["role"], by_name["nobody"]["active"]), (None, False))
        text = json.dumps(body)
        for secret in (PASSWORD, "md5$", "pbkdf2", "password", "hash"):
            self.assertNotIn(secret, text)
        self.assertIn("no-store", self.client_.get(USERS)["Cache-Control"])
        detail = self.client_.get(self.path(viewer)).json()
        self.assertEqual(set(detail), {"generatedAt", "item"})
        self.assertEqual(detail["item"], item)
        self.assertEqual(self.client_.get(f"{USERS}999999/").status_code, 404)
        self.assertEqual(self.client_.get(f"{USERS}x/").status_code, 404)

    def test_the_list_is_searched_filtered_sorted_and_paged(self):
        make_user("alice", first_name="Alice", email="alice@example.com")
        make_user("bob", active=False)
        make_user("carol", last_name="Example")
        names = lambda **params: [item["username"] for item in self.client_.get(USERS, params).json()["items"]]  # noqa: E731
        self.assertEqual(names(), ["admin", "alice", "bob", "carol"])
        self.assertEqual(names(sort="username", dir="desc"), ["carol", "bob", "alice", "admin"])
        self.assertEqual(names(active="inactive"), ["bob"])
        self.assertEqual(names(active="active"), ["admin", "alice", "carol"])
        self.assertEqual(names(q="example"), ["alice", "carol"])  # the email, the last name
        self.assertEqual(names(q="Alice"), ["alice"])
        self.assertEqual(names(sort="joined")[0], "carol")
        self.assertEqual(names(sort="lastLogin")[-1] in ("admin", "alice", "bob", "carol"), True)
        body = self.client_.get(USERS, {"q": "example", "active": "inactive"}).json()
        self.assertEqual((body["page"]["total"], body["counts"], body["scopeTotal"]), (0, {"active": 2, "inactive": 0}, 4))
        body = self.client_.get(USERS, {"pageSize": "2", "page": "2"}).json()
        self.assertEqual(([item["username"] for item in body["items"]], body["page"]["pages"]), (["bob", "carol"], 2))
        for params in ({"active": "yes"}, {"sort": "role"}, {"dir": "up"}, {"page": "0"}, {"pageSize": "201"}, {"x": "1"}):
            with self.subTest(params=params):
                self.assertEqual(self.client_.get(USERS, params).status_code, 400)
        self.assertEqual(self.client_.get(self.path(self.admin), {"page": "1"}).status_code, 400)


class CreateTests(UserTestCase):
    def test_a_viewer_is_created_with_its_grants_and_can_sign_in_with_the_password(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "post", USERS, {
                "username": " vera ", "password": GOOD_PASSWORD, "role": "viewer", "email": "vera@example.com",
                "firstName": "Vera", "lastName": "Viewer", "customerIds": [str(self.acme.pk)], "siteIds": [str(self.plant.pk)],
            })
        self.assertEqual(response.status_code, 201, response.content)
        user = User.objects.get(username="vera")
        self.assertEqual(response["Location"], f"{USERS}{user.pk}/")
        self.assertIn("no-store", response["Cache-Control"])
        item = response.json()["item"]
        self.assertEqual(set(item), USER_KEYS)
        self.assertEqual((item["username"], item["role"], item["allCustomers"], item["active"], item["displayName"]), ("vera", "viewer", False, True, "Vera Viewer"))
        self.assertEqual(([c["id"] for c in item["customers"]], [s["id"] for s in item["sites"]]), ([str(self.acme.pk)], [str(self.plant.pk)]))
        self.assertEqual((user.is_superuser, user.is_staff, user.is_active, user.email), (False, False, True, "vera@example.com"))
        self.assertEqual(held(user), {USE_CONSOLE})
        self.assertTrue(user.check_password(GOOD_PASSWORD))
        # The new account signs in with it, and sees what it was granted.
        client, signed = sign_in("vera", GOOD_PASSWORD)
        self.assertEqual(signed.status_code, 200, signed.content)
        self.assertEqual(client.get(SESSION).json()["access"], {"allCustomers": False})
        self.assertEqual({c["name"] for c in client.get(API + "scope/").json()["customers"]}, {"Acme", "Globex"})
        [created] = self.audit("user_created")
        self.assertEqual((created.actor_id, created.target_type, created.target_id, created.target_name), (self.admin.pk, "user", str(user.pk), "vera"))
        self.assertEqual(created.changes["role"], {"before": None, "after": "viewer"})
        self.assertEqual(created.changes["customerIds"], {"before": None, "after": [str(self.acme.pk)]})
        self.assertEqual(created.changes["siteIds"], {"before": None, "after": [str(self.plant.pk)]})
        self.assertEqual(created.changes["active"], {"before": None, "after": True})
        text = json.dumps(created.changes) + "\n".join(logs.output) + json.dumps(response.json())
        self.assertNotIn(GOOD_PASSWORD, text)
        self.assertNotIn("password", json.dumps(created.changes))
        self.assertNotIn(user.password, text)
        self.assertEqual(logs.output, [f"INFO:apps.console:User created (user={user.pk}, role=viewer, by_user_id={self.admin.pk})"])

    def test_each_role_sets_exactly_its_permissions(self):
        for role, permissions, superuser, all_customers in (
            ("viewer", ROLE_PERMISSIONS[VIEWER], False, False),
            ("operator", ROLE_PERMISSIONS[OPERATOR], False, False),
            ("editor", ROLE_PERMISSIONS[EDITOR], False, True),
            ("administrator", frozenset(), True, True),
        ):
            with self.subTest(role=role):
                response = send(self.client_, "post", USERS, {"username": role, "password": GOOD_PASSWORD, "role": role})
                self.assertEqual(response.status_code, 201, response.content)
                user = User.objects.get(username=role)
                self.assertEqual(held(user), set(permissions))
                self.assertEqual((user.is_superuser, user.is_staff), (superuser, superuser))
                self.assertEqual((response.json()["item"]["role"], response.json()["item"]["allCustomers"]), (role, all_customers))
                self.assertEqual(role_of(user.is_superuser, held(user)), role)
        # A viewer or operator may be given every customer; the other roles have it already.
        response = send(self.client_, "post", USERS, {"username": "wide-viewer", "password": GOOD_PASSWORD, "role": "viewer", "allCustomers": True})
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(held(User.objects.get(username="wide-viewer")), {USE_CONSOLE, VIEW_ALL_CUSTOMERS})
        self.assertEqual((response.json()["item"]["role"], response.json()["item"]["allCustomers"]), ("viewer", True))
        response = send(self.client_, "post", USERS, {"username": "narrow-editor", "password": GOOD_PASSWORD, "role": "editor", "allCustomers": False})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"allCustomers": ["Editors and administrators see every customer."]}))

    def test_a_new_administrator_may_do_everything_an_administrator_does(self):
        self.assertEqual(send(self.client_, "post", USERS, {"username": "second", "password": GOOD_PASSWORD, "role": "administrator"}).status_code, 201)
        client, signed = sign_in("second", GOOD_PASSWORD)
        self.assertEqual(signed.status_code, 200)
        capabilities = client.get(SESSION).json()["capabilities"]
        self.assertTrue(all(capabilities.values()), capabilities)
        self.assertEqual(client.get(USERS).status_code, 200)

    def test_the_password_is_checked_by_the_installations_validators(self):
        for password, messages in (
            ("short", ["This password is too short. It must contain at least 8 characters."]),
            ("password", ["This password is too common."]),
            ("12345678901", ["This password is too common.", "This password is entirely numeric."]),
            ("vera-viewer", ["The password is too similar to the username."]),
        ):
            with self.subTest(password=password):
                response = send(self.client_, "post", USERS, {"username": "vera-viewer", "password": password, "role": "viewer"})
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()["error"]["fields"]["password"], messages)
        # What was sent is never echoed: the validators name the rule, not the password.
        self.assertNotIn("12345678901", send(self.client_, "post", USERS, {"username": "vera-viewer", "password": "12345678901", "role": "viewer"}).content.decode())
        self.assertFalse(User.objects.filter(username="vera-viewer").exists())
        self.assertFalse(AuditEntry.objects.exists())

    def test_a_user_name_is_taken_in_any_spelling_the_sign_in_reads(self):
        make_user("ada")
        response = send(self.client_, "post", USERS, {"username": "ada", "password": GOOD_PASSWORD, "role": "viewer"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "user_exists"))
        response = send(self.client_, "post", USERS, {"username": "ａｄａ", "password": GOOD_PASSWORD, "role": "viewer"})  # full-width: NFKC spells it "ada"
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "user_exists"))
        self.assertEqual(User.objects.filter(username="ada").count(), 1)
        self.assertFalse(AuditEntry.objects.exists())

    def test_the_body_is_checked_field_by_field(self):
        base = {"username": "new", "password": GOOD_PASSWORD, "role": "viewer"}
        cases = [
            ({}, "username", "Required."),
            ({}, "password", "Required."),
            ({}, "role", "Required."),
            ({**base, "username": "  "}, "username", "Required."),
            ({**base, "username": "a" * 151}, "username", "At most 150 characters."),
            ({**base, "username": "new\x1b"}, "username", "Control characters are not allowed."),
            ({**base, "username": "new user"}, "username", "Enter a valid username. This value may contain only letters, numbers, and @/./+/-/_ characters."),
            ({**base, "password": ""}, "password", "Required: text of at most 1024 characters."),
            ({**base, "password": 1234}, "password", "Required: text of at most 1024 characters."),
            ({**base, "password": "p" * 1025}, "password", "Required: text of at most 1024 characters."),
            ({**base, "role": "owner"}, "role", "Expected one of administrator, editor, operator, viewer."),
            ({**base, "role": 1}, "role", "Expected one of administrator, editor, operator, viewer."),
            ({**base, "email": "not-an-email"}, "email", "Enter a valid email address."),
            ({**base, "email": "e" * 255}, "email", "At most 254 characters."),
            ({**base, "firstName": 7}, "firstName", "Expected text."),
            ({**base, "active": "yes"}, "active", "Expected true or false."),
            ({**base, "allCustomers": "yes"}, "allCustomers", "Expected true or false."),
            ({**base, "customerIds": "all"}, "customerIds", "Expected a list of at most 500 customer ids."),
            ({**base, "customerIds": ["x"]}, "customerIds", "Expected a list of customer ids."),
            ({**base, "customerIds": ["00000000-0000-0000-0000-000000000000"]}, "customerIds", "One of the customers does not exist."),
            ({**base, "siteIds": [str(self.acme.pk)]}, "siteIds", "One of the sites does not exist."),
            ({**base, "isSuperuser": True}, "isSuperuser", "Unknown field."),
            ({**base, "groups": [1]}, "groups", "Unknown field."),
            ({**base, "permissions": ["auth.add_user"]}, "permissions", "Unknown field."),
        ]
        for body, field, message in cases:
            with self.subTest(body=body):
                response = send(self.client_, "post", USERS, body)
                self.assertEqual(response.status_code, 400, response.content)
                error = response.json()["error"]
                self.assertEqual(error["code"], "validation_error")
                self.assertEqual(error["fields"][field], [message])
        self.assertFalse(User.objects.filter(username="new").exists())
        self.assertFalse(AuditEntry.objects.exists())
        self.assertEqual(send(self.client_, "post", USERS, {**base, "firstName": "f" * 33 * 1024}).status_code, 413)
        self.assertEqual(self.client_.post(USERS, "username=x", content_type="text/plain").status_code, 415)


class ChangeTests(UserTestCase):
    def setUp(self):
        super().setUp()
        self.viewer = make_user("viewer", customers=[self.acme], email="old@example.com")

    def test_the_fields_sent_change_and_the_rest_stays(self):
        kept = CustomerAccess.objects.get(user=self.viewer)
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "patch", self.path(self.viewer), {
                "firstName": "Vera", "email": "vera@example.com", "customerIds": [str(self.acme.pk), str(self.globex.pk)], "siteIds": [str(self.plant.pk)],
            })
        self.assertEqual(response.status_code, 200, response.content)
        user = User.objects.get(pk=self.viewer.pk)
        self.assertEqual((user.first_name, user.email, user.username, user.is_active), ("Vera", "vera@example.com", "viewer", True))
        self.assertEqual(set(CustomerAccess.objects.filter(user=user).values_list("customer_id", flat=True)), {self.acme.pk, self.globex.pk})
        self.assertEqual(CustomerAccess.objects.get(user=user, customer=self.acme).pk, kept.pk)  # the kept grant is the same row
        self.assertEqual(list(SiteAccess.objects.filter(user=user).values_list("site_id", flat=True)), [self.plant.pk])
        self.assertEqual(response.json()["item"]["role"], "viewer")
        [changed] = self.audit("user_changed")
        self.assertEqual(changed.changes, {
            "customerIds": {"before": [str(self.acme.pk)], "after": sorted([str(self.acme.pk), str(self.globex.pk)])},
            "email": {"before": "old@example.com", "after": "vera@example.com"},
            "firstName": {"before": "", "after": "Vera"},
            "siteIds": {"before": [], "after": [str(self.plant.pk)]},
        })
        self.assertIn(f"User changed (user={user.pk}, fields=customerIds,email,firstName,siteIds, by_user_id={self.admin.pk})", "\n".join(logs.output))
        # Grants are replaced by what is sent: an empty list takes them all away; a kind not sent stays.
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"customerIds": []}).status_code, 200)
        self.assertFalse(CustomerAccess.objects.filter(user=user).exists())
        self.assertTrue(SiteAccess.objects.filter(user=user).exists())
        # Nothing to change: nothing recorded.
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"firstName": "Vera"}).status_code, 200)
        self.assertEqual(len(self.audit("user_changed")), 2)

    def test_a_role_resets_the_permissions_and_takes_the_account_out_of_its_groups(self):
        group = Group.objects.create(name="legacy")
        group.permissions.add(Permission.objects.get(codename="add_user"))
        self.viewer.groups.add(group)
        grant(self.viewer, "alerts.acknowledge_incident")
        response = send(self.client_, "patch", self.path(self.viewer), {"role": "editor"})
        self.assertEqual(response.status_code, 200, response.content)
        user = User.objects.get(pk=self.viewer.pk)
        self.assertEqual(held(user), set(ROLE_PERMISSIONS[EDITOR]))
        self.assertFalse(user.groups.exists())
        self.assertFalse(user.has_perm("auth.add_user"))
        self.assertEqual((response.json()["item"]["role"], response.json()["item"]["allCustomers"]), ("editor", True))
        [changed] = self.audit("user_changed")
        self.assertEqual(changed.changes, {"allCustomers": {"before": False, "after": True}, "role": {"before": "viewer", "after": "editor"}})
        # Promoted to administrator: a superuser, who may use the admin; and back to a viewer, who may not.
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"role": "administrator"}).status_code, 200)
        user.refresh_from_db()
        self.assertEqual((user.is_superuser, user.is_staff, held(user)), (True, True, set()))
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"role": "viewer"}).status_code, 200)
        user.refresh_from_db()
        # Demoted: no longer a superuser. It keeps every customer until told otherwise (the answer says so).
        self.assertEqual((user.is_superuser, user.is_staff, held(user)), (False, False, {USE_CONSOLE, VIEW_ALL_CUSTOMERS}))
        self.assertTrue(self.client_.get(self.path(self.viewer)).json()["item"]["allCustomers"])
        # Every customer taken away from a viewer, given again, and the role and the scope set at once.
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"allCustomers": False}).status_code, 200)
        self.assertEqual(held(User.objects.get(pk=self.viewer.pk)), {USE_CONSOLE})
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"allCustomers": True}).status_code, 200)
        self.assertEqual(held(User.objects.get(pk=self.viewer.pk)), {USE_CONSOLE, VIEW_ALL_CUSTOMERS})
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"role": "operator", "allCustomers": False}).status_code, 200)
        self.assertEqual(held(User.objects.get(pk=self.viewer.pk)), set(ROLE_PERMISSIONS[OPERATOR]))
        response = send(self.client_, "patch", self.path(self.viewer), {"role": "editor", "allCustomers": False})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"allCustomers": ["Editors and administrators see every customer."]}))
        nobody = make_user("nobody", console=False)
        response = send(self.client_, "patch", self.path(nobody), {"allCustomers": True})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"allCustomers": ["Give the account a role first."]}))

    def test_deactivating_ends_the_sessions_and_keeps_the_grants(self):
        viewer_client = signed_in_client(self.viewer)
        self.assertEqual(viewer_client.get(API + "scope/").status_code, 200)
        response = send(self.client_, "patch", self.path(self.viewer), {"active": False})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["item"]["active"], False)
        self.assertEqual(viewer_client.get(API + "scope/").status_code, 401)
        self.assertEqual(sign_in("viewer", PASSWORD)[1].status_code, 401)
        self.assertTrue(CustomerAccess.objects.filter(user=self.viewer).exists())
        [deactivated] = self.audit("user_deactivated")
        self.assertEqual(deactivated.changes, {"active": {"before": True, "after": False}})
        self.assertEqual(self.audit("user_changed"), [])
        # Deactivated and renamed at once: the switch is its own entry.
        self.assertEqual(send(self.client_, "patch", self.path(self.viewer), {"active": True, "lastName": "Viewer"}).status_code, 200)
        [activated] = self.audit("user_activated")
        self.assertEqual(activated.changes, {"active": {"before": False, "after": True}})
        [changed] = self.audit("user_changed")
        self.assertEqual(changed.changes, {"lastName": {"before": "", "after": "Viewer"}})
        self.assertEqual(sign_in("viewer", PASSWORD)[1].status_code, 200)

    def test_your_own_account_is_neither_deactivated_nor_demoted_here(self):
        make_admin("second")
        for body in ({"active": False}, {"role": "editor"}, {"role": "viewer", "active": False}):
            with self.subTest(body=body):
                response = send(self.client_, "patch", self.path(self.admin), body)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "own_account"))
        admin = User.objects.get(pk=self.admin.pk)
        self.assertEqual((admin.is_active, admin.is_superuser), (True, True))
        self.assertFalse(AuditEntry.objects.exists())
        # Your own name and email, and your own role said again, are fine.
        self.assertEqual(send(self.client_, "patch", self.path(self.admin), {"firstName": "Ada", "role": "administrator"}).status_code, 200)

    def test_the_last_active_administrator_is_kept(self):
        second = make_admin("second")
        former = make_admin("former", active=False)
        client = signed_in_client(second)
        # Two active administrators: the first may be demoted by the second...
        self.assertEqual(send(client, "patch", self.path(self.admin), {"role": "editor"}).status_code, 200)
        self.assertFalse(User.objects.get(pk=self.admin.pk).is_superuser)
        # ... who is now the last one. Nobody else may change accounts (an inactive administrator does not count,
        # and the demoted one no longer may), and it cannot deactivate or demote itself: the installation keeps it.
        self.assertEqual(send(self.client_, "patch", self.path(second), {"active": False}).status_code, 403)
        self.assertEqual(send(self.client_, "patch", self.path(former), {"active": True}).status_code, 403)
        for body in ({"active": False}, {"role": "editor"}, {"role": "viewer", "active": False}):
            with self.subTest(body=body):
                response = send(client, "patch", self.path(second), body)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "own_account"))
        second.refresh_from_db()
        self.assertEqual((second.is_active, second.is_superuser), (True, True))
        # Two administrators demoting each other at once: every administrator's row is held, so the transaction that
        # commits second finds its target alone and is refused. This is what that second transaction sees.
        with transaction.atomic(), self.assertRaises(ApiError) as caught:
            guard_administrators(former, second, deactivating=True, demoting=False)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "last_administrator"))
        with transaction.atomic():
            guard_administrators(former, second, deactivating=False, demoting=False)  # nothing of the kind: no check
        # Reactivating the former one makes two again, and each may demote the other, never itself.
        self.assertEqual(send(client, "patch", self.path(former), {"active": True}).status_code, 200)
        self.assertEqual(send(signed_in_client(former), "patch", self.path(former), {"role": "editor"}).status_code, 409)
        self.assertEqual(send(signed_in_client(former), "patch", self.path(second), {"role": "editor"}).status_code, 200)
        self.assertEqual(User.objects.filter(is_superuser=True, is_active=True).count(), 1)

    def test_a_password_is_not_set_here_and_a_name_must_be_free(self):
        response = send(self.client_, "patch", self.path(self.viewer), {"password": GOOD_PASSWORD})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"password": ["A password is set from its own endpoint."]}))
        self.assertTrue(User.objects.get(pk=self.viewer.pk).check_password(PASSWORD))
        response = send(self.client_, "patch", self.path(self.viewer), {"username": "ADMIN"})
        self.assertEqual(response.status_code, 200, response.content)  # the model's unique check is exact
        response = send(self.client_, "patch", self.path(self.viewer), {"username": "admin"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "user_exists"))
        self.assertEqual(self.client_.get(self.path(self.viewer)).json()["item"]["username"], "ADMIN")
        self.assertEqual(send(self.client_, "patch", f"{USERS}999999/", {"firstName": "x"}).status_code, 404)


class PasswordTests(UserTestCase):
    def setUp(self):
        super().setUp()
        self.viewer = make_user("viewer", customers=[self.acme])

    def test_an_administrator_sets_a_new_password_which_ends_the_accounts_sessions(self):
        viewer_client = signed_in_client(self.viewer)
        self.assertEqual(viewer_client.get(API + "scope/").status_code, 200)
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "post", self.path(self.viewer, "password/"), {"password": GOOD_PASSWORD})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(set(response.json()), {"generatedAt", "item"})
        self.assertTrue(User.objects.get(pk=self.viewer.pk).check_password(GOOD_PASSWORD))
        self.assertEqual(viewer_client.get(API + "scope/").status_code, 401)  # the old session is over
        self.assertEqual(sign_in("viewer", PASSWORD)[1].status_code, 401)
        self.assertEqual(sign_in("viewer", GOOD_PASSWORD)[1].status_code, 200)
        [reset] = self.audit("user_password_reset")
        self.assertEqual((reset.actor_id, reset.target_id, reset.changes), (self.admin.pk, str(self.viewer.pk), {}))
        text = "\n".join(logs.output) + json.dumps(response.json())
        self.assertNotIn(GOOD_PASSWORD, text)
        self.assertNotIn("password", json.dumps(response.json()).lower().replace("user_password_reset", ""))
        self.assertEqual(logs.output, [f"INFO:apps.console:User password reset (user={self.viewer.pk}, by_user_id={self.admin.pk})"])

    def test_the_new_password_is_checked_and_your_own_is_changed_elsewhere(self):
        for password in ("short", "password", "theviewer1"):  # too short, too common, too similar to the user name
            with self.subTest(password=password):
                response = send(self.client_, "post", self.path(self.viewer, "password/"), {"password": password})
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(set(response.json()["error"]["fields"]), {"password"})
        response = send(self.client_, "post", self.path(self.viewer, "password/"), {"password": GOOD_PASSWORD, "notify": True})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"notify": ["Unknown field."]}))
        response = send(self.client_, "post", self.path(self.admin, "password/"), {"password": GOOD_PASSWORD})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "own_account"))
        self.assertTrue(User.objects.get(pk=self.viewer.pk).check_password(PASSWORD))
        self.assertTrue(User.objects.get(pk=self.admin.pk).check_password(PASSWORD))
        self.assertEqual(send(self.client_, "post", f"{USERS}999999/password/", {"password": GOOD_PASSWORD}).status_code, 404)
        self.assertFalse(AuditEntry.objects.exists())

    def test_a_locked_account_is_unlocked_as_the_command_unlocks_it(self):
        for _ in range(4):
            self.assertEqual(sign_in("viewer", "wrong-" + PASSWORD)[1].status_code, 401)
        self.assertEqual(sign_in("viewer", PASSWORD)[1].status_code, 401)  # locked: even the right password is refused
        self.assertTrue(self.client_.get(self.path(self.viewer)).json()["item"]["locked"])
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "post", self.path(self.viewer, "unlock/"))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()["item"]["locked"], response.json()["item"]["lockedUntil"]), (False, None))
        self.assertFalse(LoginThrottle.objects.filter(user=self.viewer).exists())
        self.assertEqual(sign_in("viewer", PASSWORD)[1].status_code, 200)
        [unlocked] = self.audit("user_unlocked")
        self.assertEqual(unlocked.changes, {"locked": {"before": True, "after": False}})
        self.assertIn(f"User unlocked (user={self.viewer.pk}, was_locked=True, by_user_id={self.admin.pk})", "\n".join(logs.output))
        # Unlocking an account that is not locked is fine, and said so.
        self.assertEqual(send(self.client_, "post", self.path(self.viewer, "unlock/"), {}).status_code, 200)
        self.assertEqual(self.audit("user_unlocked")[1].changes, {"locked": {"before": False, "after": False}})
        response = send(self.client_, "post", self.path(self.viewer, "unlock/"), {"all": True})
        self.assertEqual(response.status_code, 400)

    def test_everyone_changes_their_own_password_with_the_current_one(self):
        client = signed_in_client(self.viewer)
        other = signed_in_client(self.viewer)
        response = send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": "wrong-" + PASSWORD, "newPassword": GOOD_PASSWORD})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"currentPassword": ["The current password is not right."]}))
        response = send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": PASSWORD, "newPassword": "short"})
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(set(response.json()["error"]["fields"]), {"newPassword"})
        response = send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": PASSWORD, "newPassword": GOOD_PASSWORD, "username": "x"})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"username": ["Unknown field."]}))
        self.assertTrue(User.objects.get(pk=self.viewer.pk).check_password(PASSWORD))
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": PASSWORD, "newPassword": GOOD_PASSWORD})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(set(response.json()), {"generatedAt", "changedAt"})
        self.assertTrue(User.objects.get(pk=self.viewer.pk).check_password(GOOD_PASSWORD))
        self.assertTrue(client.get(SESSION).json()["authenticated"])  # this session goes on
        self.assertFalse(other.get(SESSION).json()["authenticated"])  # every other one ends
        [changed] = self.audit("user_password_changed")
        self.assertEqual((changed.actor_id, changed.target_id, changed.changes), (self.viewer.pk, str(self.viewer.pk), {}))
        self.assertNotIn(GOOD_PASSWORD, "\n".join(logs.output))
        self.assertNotIn(PASSWORD, "\n".join(logs.output))
        self.assertEqual(logs.output, [f"INFO:apps.console:Own password changed (user_id={self.viewer.pk})"])
        # The administrator too, from the same place.
        self.assertEqual(send(self.client_, "put", ACCOUNT_PASSWORD, {"currentPassword": PASSWORD, "newPassword": OTHER_PASSWORD}).status_code, 200)

    def test_guessing_the_current_password_is_throttled_as_the_sign_in_is(self):
        client = signed_in_client(self.viewer)
        for _ in range(3):
            self.assertEqual(send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": "wrong", "newPassword": GOOD_PASSWORD}).status_code, 400)
        response = send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": PASSWORD, "newPassword": GOOD_PASSWORD})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (429, "too_many_attempts"))
        self.assertTrue(User.objects.get(pk=self.viewer.pk).check_password(PASSWORD))
        self.assertTrue(self.client_.get(self.path(self.viewer)).json()["item"]["locked"])
        # The administrator unlocks it, and the change goes through and forgets the failures.
        self.assertEqual(send(self.client_, "post", self.path(self.viewer, "unlock/")).status_code, 200)
        self.assertEqual(send(client, "put", ACCOUNT_PASSWORD, {"currentPassword": PASSWORD, "newPassword": GOOD_PASSWORD}).status_code, 200)
        self.assertFalse(LoginThrottle.objects.filter(user=self.viewer).exists())


class RoleTests(TestCase):
    def test_the_role_is_the_highest_whose_every_permission_is_held(self):
        self.assertEqual(role_of(True, set()), ADMINISTRATOR)
        self.assertEqual(role_of(False, set(ROLE_PERMISSIONS[EDITOR])), EDITOR)
        self.assertEqual(role_of(False, set(ROLE_PERMISSIONS[EDITOR]) | {"auth.add_user"}), EDITOR)
        self.assertEqual(role_of(False, set(ROLE_PERMISSIONS[EDITOR]) - {"network.add_networktarget"}), OPERATOR)
        self.assertEqual(role_of(False, set(ROLE_PERMISSIONS[OPERATOR])), OPERATOR)
        self.assertEqual(role_of(False, {USE_CONSOLE, VIEW_ALL_CUSTOMERS}), VIEWER)
        self.assertEqual(role_of(False, {USE_CONSOLE}), VIEWER)
        self.assertIsNone(role_of(False, set()))
        self.assertIsNone(role_of(False, {VIEW_ALL_CUSTOMERS, "alerts.change_alertrule"}))

    def test_every_role_permission_exists(self):
        for role, names in ROLE_PERMISSIONS.items():
            for name in names:
                app, codename = name.split(".", 1)
                with self.subTest(role=role, permission=name):
                    self.assertTrue(Permission.objects.filter(content_type__app_label=app, codename=codename).exists())
