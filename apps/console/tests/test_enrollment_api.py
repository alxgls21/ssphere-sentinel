"""Adding monitored hosts from the console: a server, its agent and the agent's token (``apps.console.enrollment``)."""

import json
import threading
from unittest import mock

from django.db import connection
from django.test import Client, TestCase, TransactionTestCase, override_settings

from apps.agents.models import Agent
from apps.agents.tokens import hash_token
from apps.console.tests.helpers import API, grant, make_user, signed_in_client
from apps.infrastructure.models import Server
from apps.inventory.models import Customer, Site

SERVERS = API + "servers/"
HEARTBEAT = "/api/v1/agent/heartbeat/"
ITEM_KEYS = {"id", "name", "enabled", "lastSeenAt", "agentVersion", "createdAt", "updatedAt"}
# The hostname and the token are the two values a host needs; the token comes back once, with the address.
TOKEN_KEYS = {"generatedAt", "item", "token", "serverUrl"}
# What the admin asks for the same actions: adding a server, adding an agent, changing (rotating, disabling) one.
MODEL_PERMISSIONS = ("infrastructure.add_server", "agents.add_agent", "agents.change_agent")
NOT_A_HOSTNAME = "Expected a host name (letters, digits, hyphens and dots) or an IP address."


def host_admin(username="ops", **options):
    """An account that may add hosts: it may change alert rules and holds the admin's permissions on servers and agents."""
    return grant(make_user(username, all_customers=True, **options), "alerts.change_alertrule", *MODEL_PERMISSIONS)


def post(client: Client, path: str, body=None, **extra):
    if body is None:
        return client.post(path, **extra)
    return client.post(path, json.dumps(body), content_type="application/json", **extra)


def patch(client: Client, path: str, body, **extra):
    return client.patch(path, json.dumps(body), content_type="application/json", **extra)


def heartbeat(token: str) -> int:
    return Client().post(HEARTBEAT, data="{}", content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}").status_code


def agents_of(server_id) -> str:
    return f"{SERVERS}{server_id}/agents/"


def rotate_of(agent_id) -> str:
    return f"{API}agents/{agent_id}/rotate-token/"


def agent_of(agent_id) -> str:
    return f"{API}agents/{agent_id}/"


class EnrollmentTestCase(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.admin = host_admin()
        self.client_ = signed_in_client(self.admin)

    def add_server(self, name="web-1", **fields):
        response = post(self.client_, SERVERS, {"name": name, **fields})
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def add_agent(self, server_id, body=None):
        response = post(self.client_, agents_of(server_id), body if body is not None else {})
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()


class PermissionTests(EnrollmentTestCase):
    def setUp(self):
        super().setUp()
        self.server = Server.objects.create(name="existing", hostname="existing.local")
        self.agent = Agent.objects.create(server=self.server, name="existing-agent", token_hash=hash_token("x"))

    def attempts(self, client):
        return (
            post(client, SERVERS, {"name": "new-host"}),
            post(client, agents_of(self.server.pk), {}),
            post(client, rotate_of(self.agent.pk)),
            patch(client, agent_of(self.agent.pk), {"enabled": False}),
        )

    def assert_refused(self, client, status):
        for response in self.attempts(client):
            self.assertEqual(response.status_code, status, response.content)
            self.assertNotIn("token", response.content.decode().replace("rotate-token", ""))
        self.assertFalse(Server.objects.filter(name="new-host").exists())
        self.assertEqual(Agent.objects.get().token_hash, hash_token("x"))
        self.assertTrue(Agent.objects.get().enabled)

    def test_anonymous_requests_are_refused(self):
        self.assert_refused(Client(), 401)

    def test_a_session_without_the_console_is_refused(self):
        staff = grant(make_user("staff", console=False, all_customers=True), "alerts.change_alertrule", *MODEL_PERMISSIONS)
        self.assert_refused(signed_in_client(staff), 403)

    def test_the_rule_permission_and_every_customer_are_both_needed(self):
        # Every customer and the admin's permissions, but not the rule permission: the same as any reader.
        self.assert_refused(signed_in_client(make_user("plain", all_customers=True)), 403)
        self.assert_refused(signed_in_client(grant(make_user("viewer", all_customers=True), "alerts.view_alertrule", *MODEL_PERMISSIONS)), 403)
        self.assert_refused(signed_in_client(grant(make_user("adder", all_customers=True), "alerts.add_alertrule", *MODEL_PERMISSIONS)), 403)
        # The permissions, but not every customer: a host may be placed on any customer's site.
        restricted = grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", *MODEL_PERMISSIONS)
        self.assert_refused(signed_in_client(restricted), 403)
        root = signed_in_client(make_user("root", superuser=True))
        created = post(root, SERVERS, {"name": "new-host"})
        self.assertEqual(created.status_code, 201, created.content)
        self.assertEqual(post(root, agents_of(created.json()["item"]["server"]["id"]), {}).status_code, 201)
        self.assertEqual(post(root, rotate_of(self.agent.pk)).status_code, 200)
        self.assertEqual(patch(root, agent_of(self.agent.pk), {"enabled": False}).status_code, 200)

    def test_the_admins_permissions_on_servers_and_agents_are_needed_too(self):
        # Who may change rules but holds no permission on servers or agents: refused, and the session says so.
        editor = grant(make_user("editor", all_customers=True), "alerts.change_alertrule")
        self.assert_refused(signed_in_client(editor), 403)
        self.assertFalse(signed_in_client(editor).get(API + "session/").json()["capabilities"]["manageServers"])
        # The admin's permissions without the rule permission: the same.
        admin_only = grant(make_user("admin-only", all_customers=True), *MODEL_PERMISSIONS)
        self.assert_refused(signed_in_client(admin_only), 403)
        self.assertFalse(signed_in_client(admin_only).get(API + "session/").json()["capabilities"]["manageServers"])

    def test_each_write_needs_the_permission_the_admin_asks_for_it(self):
        bare = Server.objects.create(name="bare", hostname="bare")
        # Each account may change rules and holds one of the three; the capability needs all of them.
        for codename, expected in (
            ("infrastructure.add_server", (201, 403, 403, 403)),
            ("agents.add_agent", (403, 201, 403, 403)),
            ("agents.change_agent", (403, 403, 200, 200)),
        ):
            with self.subTest(permission=codename):
                client = signed_in_client(grant(make_user(codename, all_customers=True), "alerts.change_alertrule", codename))
                responses = (
                    post(client, SERVERS, {"name": f"host-{codename}"}),
                    post(client, agents_of(bare.pk), {}),
                    post(client, rotate_of(self.agent.pk)),
                    patch(client, agent_of(self.agent.pk), {"enabled": True}),
                )
                self.assertEqual(tuple(response.status_code for response in responses), expected)
                self.assertFalse(client.get(API + "session/").json()["capabilities"]["manageServers"])

    def test_the_refusal_names_the_permission_not_the_host(self):
        response = post(signed_in_client(make_user("plain", all_customers=True)), SERVERS, {"name": "existing"})
        self.assertEqual(response.json()["error"], {"code": "forbidden", "message": "This account may not add or change monitored hosts."})

    def test_the_session_says_what_the_account_may_do(self):
        self.assertTrue(self.client_.get(API + "session/").json()["capabilities"]["manageServers"])
        for user in (
            make_user("plain", all_customers=True),
            grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", *MODEL_PERMISSIONS),
            grant(make_user("adder", all_customers=True), "alerts.add_alertrule", *MODEL_PERMISSIONS),
            grant(make_user("editor", all_customers=True), "alerts.change_alertrule"),
            grant(make_user("admin-only", all_customers=True), *MODEL_PERMISSIONS),
            grant(make_user("no-change-agent", all_customers=True), "alerts.change_alertrule", *MODEL_PERMISSIONS[:2]),
        ):
            with self.subTest(user=user.username):
                self.assertFalse(signed_in_client(user).get(API + "session/").json()["capabilities"]["manageServers"])

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.admin, enforce_csrf=True)
        for response in self.attempts(client):
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        self.assertFalse(Server.objects.filter(name="new-host").exists())
        self.assertEqual(Agent.objects.get().token_hash, hash_token("x"))
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(post(client, SERVERS, {"name": "new-host"}, HTTP_X_CSRFTOKEN=token).status_code, 201)
        self.assertEqual(post(client, rotate_of(self.agent.pk), HTTP_X_CSRFTOKEN=token).status_code, 200)
        self.assertEqual(patch(client, agent_of(self.agent.pk), {"enabled": False}, HTTP_X_CSRFTOKEN=token).status_code, 200)

    def test_only_the_documented_methods(self):
        self.assertEqual(self.client_.get(rotate_of(self.agent.pk)).status_code, 405)
        self.assertEqual(self.client_.get(agents_of(self.server.pk)).status_code, 405)
        self.assertEqual(self.client_.delete(agent_of(self.agent.pk)).status_code, 405)
        self.assertEqual(self.client_.get(agent_of(self.agent.pk)).status_code, 405)
        self.assertEqual(self.client_.put(SERVERS, "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.get(SERVERS).status_code, 200)  # the list is as it was

    def test_the_list_and_the_detail_are_still_read_by_anyone_who_sees_the_server(self):
        viewer = signed_in_client(make_user("viewer", all_customers=True))
        self.assertEqual(viewer.get(SERVERS).status_code, 200)
        detail = viewer.get(f"{SERVERS}{self.server.pk}/").json()
        self.assertEqual(set(detail["agent"]), ITEM_KEYS)
        self.assertNotIn("token", json.dumps(detail))


class CreateServerTests(EnrollmentTestCase):
    def test_a_server_is_created_with_its_detail_and_no_agent_yet(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = post(self.client_, SERVERS, {
                "name": "  web-1 ", "hostname": "web-1.example.net", "description": "front", "operatingSystem": "Debian 12",
                "ipAddress": "10.0.0.5", "siteId": str(self.hq.pk),
            })
        self.assertEqual(response.status_code, 201, response.content)
        server = Server.objects.get()
        self.assertEqual(response["Location"], f"{SERVERS}{server.pk}/")
        self.assertIn("no-store", response["Cache-Control"])
        body = response.json()
        self.assertEqual(set(body), {"generatedAt", "item", "agent", "containers"})
        self.assertIsNone(body["agent"])
        self.assertEqual(body["containers"], [])
        item = body["item"]
        self.assertEqual(item["server"]["id"], str(server.pk))
        self.assertEqual((item["server"]["name"], item["server"]["hostname"]), ("web-1", "web-1.example.net"))
        self.assertEqual((item["server"]["ipAddress"], item["server"]["operatingSystem"]), ("10.0.0.5", "Debian 12"))
        self.assertEqual((item["server"]["siteId"], item["customerName"], item["siteName"]), (str(self.hq.pk), "Acme", "HQ"))
        self.assertEqual((item["server"]["status"], item["health"], item["server"]["lastSeenAt"]), ("unknown", "unknown", None))
        self.assertEqual((server.description, server.status), ("front", Server.Status.UNKNOWN))
        self.assertEqual(body, self.client_.get(f"{SERVERS}{server.pk}/").json() | {"generatedAt": body["generatedAt"]})
        self.assertEqual(logs.output, [f"INFO:apps.console:Server created (server={server.pk}, site={self.hq.pk}, user_id={self.admin.pk})"])

    def test_only_the_name_is_required(self):
        body = self.add_server("db-1")
        server = Server.objects.get()
        self.assertEqual((server.hostname, server.description, server.operating_system, server.ip_address, server.site_id), ("db-1", "", "", None, None))
        self.assertEqual((body["item"]["server"]["siteId"], body["item"].get("customerName")), (None, None))
        self.assertEqual(self.add_server("db-2", hostname="  ", ipAddress=None, siteId=None, description="", operatingSystem="")["item"]["server"]["hostname"], "db-2")

    def test_an_ipv6_address_is_stored_as_the_model_stores_it(self):
        body = self.add_server("v6", ipAddress="2001:DB8:0:0:0:0:0:1")
        self.assertEqual(body["item"]["server"]["ipAddress"], "2001:db8::1")

    def test_a_server_without_a_site_is_seen_by_every_customer_accounts_only(self):
        body = self.add_server("lonely")
        restricted = signed_in_client(make_user("restricted", customers=[self.acme]))
        self.assertEqual(restricted.get(f"{SERVERS}{body['item']['server']['id']}/").status_code, 404)
        placed = self.add_server("placed", siteId=str(self.hq.pk))
        self.assertEqual(restricted.get(f"{SERVERS}{placed['item']['server']['id']}/").status_code, 200)

    def test_the_name_must_be_free(self):
        self.add_server("web-1")
        response = post(self.client_, SERVERS, {"name": "web-1"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "server_exists"))
        self.assertEqual(Server.objects.count(), 1)
        # The constraint is the model's: exact, as the admin applies it.
        self.assertEqual(post(self.client_, SERVERS, {"name": "WEB-1"}).status_code, 201)

    def test_the_body_is_checked_field_by_field(self):
        cases = [
            ({}, "name", "Required."),
            ({"name": "   "}, "name", "Required."),
            ({"name": 42}, "name", "Expected text."),
            ({"name": "a" * 256}, "name", "At most 255 characters."),
            ({"name": "nul\u0000"}, "name", "This text cannot be stored."),
            ({"name": "x", "hostname": ["h"]}, "hostname", "Expected text."),
            ({"name": "x", "hostname": "h" * 256}, "hostname", "At most 255 characters."),
            ({"name": "x", "description": "d" * 2001}, "description", "At most 2000 characters."),
            ({"name": "x", "operatingSystem": "o" * 256}, "operatingSystem", "At most 255 characters."),
            ({"name": "x", "ipAddress": "10.0.0.256"}, "ipAddress", "Expected an IPv4 or IPv6 address."),
            ({"name": "x", "ipAddress": "example.com"}, "ipAddress", "Expected an IPv4 or IPv6 address."),
            ({"name": "x", "ipAddress": 10}, "ipAddress", "Expected text."),
            ({"name": "x", "siteId": "not-an-id"}, "siteId", "Expected the id of a site."),
            ({"name": "x", "siteId": "{" + str(self.hq.pk) + "}"}, "siteId", "Expected the id of a site."),
            ({"name": "x", "siteId": "00000000-0000-0000-0000-000000000000"}, "siteId", "No such site."),
            ({"name": "x", "siteId": 7}, "siteId", "Expected the id of a site."),
            ({"name": "x", "status": "online"}, "status", "Unknown field."),
            ({"name": "x", "token": "mine"}, "token", "Unknown field."),
        ]
        for body, field, message in cases:
            with self.subTest(body=body):
                response = post(self.client_, SERVERS, body)
                self.assertEqual(response.status_code, 400, response.content)
                error = response.json()["error"]
                self.assertEqual(error["code"], "validation_error")
                self.assertEqual(error["fields"][field], [message])
        self.assertFalse(Server.objects.exists())

    def test_control_characters_are_refused_and_a_description_keeps_its_lines(self):
        for body, field in (
            ({"name": "web\n-1"}, "name"),
            ({"name": "web\x1b[31m-1"}, "name"),
            ({"name": "x", "hostname": "web\x07"}, "hostname"),
            ({"name": "x", "operatingSystem": "Debian\r12"}, "operatingSystem"),
            ({"name": "x", "description": "front\x1b[0m"}, "description"),
            ({"name": "x", "ipAddress": "10.0.0\x08.5"}, "ipAddress"),
        ):
            with self.subTest(body=body):
                response = post(self.client_, SERVERS, body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()["error"]["fields"][field], ["Control characters are not allowed."])
        self.assertFalse(Server.objects.exists())
        # Line breaks are a description's own; what is stripped off a name is not held against it.
        body = self.add_server("web-1\n", description="front\n\tsecond line\r\n")
        self.assertEqual((body["item"]["server"]["name"], Server.objects.get().description), ("web-1", "front\n\tsecond line\r\n"))

    def test_a_name_is_one_spelling_however_it_was_typed(self):
        self.add_server("café")  # a composed é
        response = post(self.client_, SERVERS, {"name": "café"})  # e and a combining acute: the same name
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "server_exists"))
        self.assertEqual(Server.objects.count(), 1)
        body = self.add_server("näive")  # stored composed, whatever was sent
        self.assertEqual(body["item"]["server"]["name"], "näive")
        self.assertEqual(Server.objects.get(pk=body["item"]["server"]["id"]).name, "näive")

    def test_a_hostname_is_a_host_name_or_an_address(self):
        for hostname in ("web-1.example.net", "localhost", "WEB-1", "9front", "10.0.0.5", "2001:db8::1", "a" * 63 + ".example"):
            with self.subTest(hostname=hostname):
                self.assertEqual(self.add_server(f"host {hostname}", hostname=hostname)["item"]["server"]["hostname"], hostname)
        for hostname in (
            "not a hostname", "web_1", "-web", "web-", "web..1", ".web", "web-1.", "web-1/", "web‑1",
            "a" * 64, ".".join(["abcde"] * 42) + ".ab",  # a label of 64; a name of 254 (within the field, over RFC 1123's 253)
        ):
            with self.subTest(hostname=hostname):
                response = post(self.client_, SERVERS, {"name": "x", "hostname": hostname})
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()["error"]["fields"]["hostname"], [NOT_A_HOSTNAME])
        self.assertFalse(Server.objects.filter(name="x").exists())
        # Blank: the name, as it is.
        self.assertEqual(self.add_server("My Server")["item"]["server"]["hostname"], "My Server")

    def test_the_body_must_be_a_json_object_within_the_limit(self):
        self.assertEqual(post(self.client_, SERVERS, [1, 2]).status_code, 400)
        self.assertEqual(self.client_.post(SERVERS, "{broken", content_type="application/json").status_code, 400)
        response = self.client_.post(SERVERS, "name=web-1", content_type="application/x-www-form-urlencoded")
        self.assertEqual(response.status_code, 415)
        huge = {"name": "web-1", "description": "d" * (16 * 1024)}
        response = post(self.client_, SERVERS, huge)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (413, "payload_too_large"))
        response = self.client_.post(SERVERS, json.dumps({"name": "web-1"}), content_type="application/json", CONTENT_LENGTH="999999")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.client_.post(SERVERS + "?x=1", json.dumps({"name": "web-1"}), content_type="application/json").status_code, 400)
        self.assertFalse(Server.objects.exists())


@override_settings(SENTINEL_URL="https://sentinel.example.test")
class CreateAgentTests(EnrollmentTestCase):
    def setUp(self):
        super().setUp()
        self.server_id = self.add_server("web-1", siteId=str(self.hq.pk))["item"]["server"]["id"]

    def test_the_token_is_answered_once_authenticates_a_heartbeat_and_is_stored_hashed_only(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = post(self.client_, agents_of(self.server_id), {"name": "web-1 agent"})
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertEqual(set(body), TOKEN_KEYS)
        token = body["token"]
        self.assertGreaterEqual(len(token), 32)
        agent = Agent.objects.get()
        self.assertEqual(body["item"]["id"], str(agent.pk))
        self.assertEqual(response["Location"], agent_of(agent.pk))
        self.assertEqual(set(body["item"]), ITEM_KEYS)
        self.assertEqual((body["item"]["name"], body["item"]["enabled"], body["item"]["lastSeenAt"], body["item"]["agentVersion"]), ("web-1 agent", True, None, ""))
        self.assertEqual(body["serverUrl"], "https://sentinel.example.test")
        # The same hashing as the admin and create_agent: the heartbeat endpoint recognises it.
        self.assertEqual(agent.token_hash, hash_token(token))
        self.assertNotIn(token, agent.token_hash)
        self.assertEqual(heartbeat(token), 200)
        self.assertIsNotNone(Server.objects.get(pk=self.server_id).last_seen_at)
        # Never cached by the browser, never in a cookie or the session, never logged.
        self.assertIn("no-store", response["Cache-Control"])
        self.assertIn("private", response["Cache-Control"])
        for cookie in response.cookies.values():
            self.assertNotIn(token, cookie.value)
        self.assertNotIn(token, json.dumps(dict(self.client_.session.items()), default=str))
        text = "\n".join(logs.output)
        self.assertNotIn(token, text)
        self.assertIn(f"Agent created (agent={agent.pk}, server={self.server_id}, user_id={self.admin.pk})", text)
        # And never answered again: the detail carries the agent, not its token.
        detail = self.client_.get(f"{SERVERS}{self.server_id}/").json()
        self.assertNotIn(token, json.dumps(detail))
        self.assertEqual(detail["agent"] | {"lastSeenAt": None}, body["item"] | {"updatedAt": detail["agent"]["updatedAt"]})
        self.assertIsNotNone(detail["agent"]["lastSeenAt"])

    def test_the_agent_is_named_after_the_server_unless_told(self):
        self.assertEqual(self.add_agent(self.server_id)["item"]["name"], "web-1")
        other = self.add_server("db-1")["item"]["server"]["id"]
        self.assertEqual(self.add_agent(other, {"name": "  "})["item"]["name"], "db-1")
        self.assertEqual(post(self.client_, agents_of(self.add_server("x")["item"]["server"]["id"])).status_code, 201)  # no body at all

    @override_settings(SENTINEL_URL="", DEBUG=True)
    def test_without_an_installation_address_the_agent_is_told_the_address_of_this_request_in_development(self):
        self.assertEqual(self.add_agent(self.server_id)["serverUrl"], "http://testserver")

    @override_settings(SENTINEL_URL="", DEBUG=False)
    def test_without_an_installation_address_no_address_is_guessed_in_production(self):
        # Behind a proxy that ends TLS the request's address is http://: the console says to set SENTINEL_URL instead.
        body = self.add_agent(self.server_id)
        self.assertEqual(set(body), TOKEN_KEYS)
        self.assertIsNone(body["serverUrl"])
        self.assertIsNone(post(self.client_, rotate_of(body["item"]["id"])).json()["serverUrl"])

    def test_an_agent_whose_token_could_not_be_answered_is_not_kept(self):
        failing = mock.patch("apps.console.servers.agent_of", side_effect=RuntimeError("the answer failed"))
        with failing, self.assertLogs("apps.console", level="ERROR"):
            response = post(self.client_, agents_of(self.server_id), {})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (500, "internal_error"))
        self.assertNotIn("token", response.content.decode())
        # Rolled back: no agent with a token nobody was shown. Tried again, it works.
        self.assertFalse(Agent.objects.exists())
        self.assertEqual(post(self.client_, agents_of(self.server_id), {}).status_code, 201)

    def test_one_agent_per_server(self):
        first = self.add_agent(self.server_id)
        response = post(self.client_, agents_of(self.server_id), {})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "agent_exists"))
        self.assertNotIn("token", json.dumps(response.json()))
        self.assertEqual(Agent.objects.count(), 1)
        self.assertEqual(heartbeat(first["token"]), 200)  # the existing agent is untouched

    def test_an_unknown_server_is_not_found(self):
        self.assertEqual(post(self.client_, agents_of("00000000-0000-0000-0000-000000000000"), {}).status_code, 404)
        self.assertEqual(post(self.client_, agents_of("not-a-uuid"), {}).status_code, 404)
        self.assertFalse(Agent.objects.exists())

    def test_the_body_is_checked(self):
        for body, field in (
            ({"name": 1}, "name"), ({"name": "n" * 256}, "name"), ({"name": "web\n-1"}, "name"),
            ({"enabled": False}, "enabled"), ({"token": "mine"}, "token"),
        ):
            with self.subTest(body=body):
                response = post(self.client_, agents_of(self.server_id), body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertEqual(post(self.client_, agents_of(self.server_id), {"name": "n" * 5000}).status_code, 413)
        self.assertEqual(self.client_.post(agents_of(self.server_id), "name=x", content_type="text/plain").status_code, 415)
        self.assertFalse(Agent.objects.exists())

    def test_every_agent_gets_its_own_token(self):
        other = self.add_server("db-1")["item"]["server"]["id"]
        first, second = self.add_agent(self.server_id)["token"], self.add_agent(other)["token"]
        self.assertNotEqual(first, second)
        self.assertEqual(len(set(Agent.objects.values_list("token_hash", flat=True))), 2)


@override_settings(SENTINEL_URL="https://sentinel.example.test")
class RotateTokenTests(EnrollmentTestCase):
    def setUp(self):
        super().setUp()
        self.server_id = self.add_server("web-1")["item"]["server"]["id"]
        created = self.add_agent(self.server_id)
        self.agent_id, self.old_token = created["item"]["id"], created["token"]

    def test_rotation_gives_a_new_token_and_ends_the_old_one_at_once(self):
        self.assertEqual(heartbeat(self.old_token), 200)
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = post(self.client_, rotate_of(self.agent_id))
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(set(body), TOKEN_KEYS)
        token = body["token"]
        self.assertNotEqual(token, self.old_token)
        self.assertEqual((body["item"]["id"], body["serverUrl"]), (self.agent_id, "https://sentinel.example.test"))
        self.assertEqual(Agent.objects.get().token_hash, hash_token(token))
        self.assertEqual(heartbeat(self.old_token), 401)
        self.assertEqual(heartbeat(token), 200)
        self.assertIn("no-store", response["Cache-Control"])
        text = "\n".join(logs.output)
        self.assertNotIn(token, text)
        self.assertNotIn(self.old_token, text)
        self.assertIn(f"Agent token rotated (agent={self.agent_id}, server={self.server_id}, user_id={self.admin.pk})", text)
        self.assertEqual(post(self.client_, rotate_of(self.agent_id), {}).status_code, 200)  # an empty object is no body

    def test_a_rotation_takes_no_options(self):
        response = post(self.client_, rotate_of(self.agent_id), {"name": "other"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("name", response.json()["error"]["fields"])
        self.assertEqual(heartbeat(self.old_token), 200)

    def test_an_unknown_agent_is_not_found(self):
        self.assertEqual(post(self.client_, rotate_of("00000000-0000-0000-0000-000000000000")).status_code, 404)
        self.assertEqual(patch(self.client_, agent_of("00000000-0000-0000-0000-000000000000"), {"enabled": False}).status_code, 404)
        self.assertEqual(heartbeat(self.old_token), 200)

    def test_a_disabled_agent_is_refused_until_enabled_again(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = patch(self.client_, agent_of(self.agent_id), {"enabled": False})
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(set(body), {"generatedAt", "item"})
        self.assertEqual((body["item"]["id"], body["item"]["enabled"]), (self.agent_id, False))
        self.assertEqual(heartbeat(self.old_token), 401)
        self.assertFalse(self.client_.get(f"{SERVERS}{self.server_id}/").json()["agent"]["enabled"])
        self.assertIn(f"Agent disabled (agent={self.agent_id}, server={self.server_id}, user_id={self.admin.pk})", "\n".join(logs.output))
        # Already disabled: nothing changes, nothing is logged. Enabled again: the same token works.
        self.assertFalse(patch(self.client_, agent_of(self.agent_id), {"enabled": False}).json()["item"]["enabled"])
        self.assertTrue(patch(self.client_, agent_of(self.agent_id), {"enabled": True}).json()["item"]["enabled"])
        self.assertEqual(heartbeat(self.old_token), 200)

    def test_a_change_is_exactly_the_enabled_flag(self):
        for body, field in (({}, "enabled"), ({"enabled": "no"}, "enabled"), ({"enabled": 0}, "enabled"), ({"enabled": True, "name": "x"}, "name")):
            with self.subTest(body=body):
                response = patch(self.client_, agent_of(self.agent_id), body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertEqual(self.client_.patch(agent_of(self.agent_id), "enabled=0", content_type="text/plain").status_code, 415)
        self.assertTrue(Agent.objects.get().enabled)


class ConcurrentTests(TransactionTestCase):
    def run_at_once(self, count, action):
        barrier = threading.Barrier(count)
        statuses = []

        def run():
            try:
                barrier.wait(timeout=10)
                statuses.append(action().status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=run) for _ in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        return sorted(statuses)

    def test_the_same_name_added_at_once_is_added_once(self):
        admin = host_admin()
        clients = iter([signed_in_client(admin) for _ in range(4)])
        lock = threading.Lock()

        def action():
            with lock:
                client = next(clients)
            return post(client, SERVERS, {"name": "web-1"})

        self.assertEqual(self.run_at_once(4, action), [201, 409, 409, 409])
        self.assertEqual(Server.objects.count(), 1)

    def test_agents_added_at_once_make_one_agent(self):
        admin = host_admin()
        server = Server.objects.create(name="web-1", hostname="web-1")
        clients = iter([signed_in_client(admin) for _ in range(4)])
        lock = threading.Lock()

        def action():
            with lock:
                client = next(clients)
            return post(client, agents_of(server.pk), {})

        self.assertEqual(self.run_at_once(4, action), [201, 409, 409, 409])
        self.assertEqual(Agent.objects.count(), 1)
