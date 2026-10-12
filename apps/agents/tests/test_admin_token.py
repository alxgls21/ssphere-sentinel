"""Regression tests: agent tokens are created and rotated in the admin without
ever passing through the messages cookie or the session, and only by users
allowed to change agents."""

import json

from django.contrib.admin.models import CHANGE, LogEntry
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import TestCase
from django.urls import reverse

from apps.agents.models import Agent
from apps.agents.services import create_agent
from apps.agents.tokens import hash_token
from apps.infrastructure.models import Server

CHANGELIST = reverse("admin:agents_agent_changelist")
ADD = reverse("admin:agents_agent_add")
HEARTBEAT = reverse("agent-heartbeat")


class AdminTokenTestCase(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        self.server = Server.objects.create(name="tok-host", hostname="tok.local")
        self.agent, self.old_token = create_agent(server=self.server, name="tok-agent")

    def _run_action(self, *pks, confirm=False):
        data = {"action": "regenerate_token", "_selected_action": [str(pk) for pk in pks]}
        if confirm:
            data["confirm"] = "yes"
        else:
            data["index"] = "0"  # submitted from the changelist action bar
        return self.client.post(CHANGELIST, data)

    def _heartbeat_status(self, token):
        return self.client.post(HEARTBEAT, HTTP_AUTHORIZATION=f"Bearer {token}").status_code

    def assert_token_not_persisted_client_side(self, response, raw_token):
        for cookie in response.cookies.values():
            self.assertNotIn(raw_token, cookie.value)
        session = self.client.session
        self.assertNotIn(raw_token, json.dumps(dict(session.items()), default=str))

    def assert_no_store(self, response):
        cache_control = response.headers.get("Cache-Control", "")
        self.assertIn("no-store", cache_control)
        self.assertIn("private", cache_control)


class RegenerateTokenTests(AdminTokenTestCase):
    def test_action_asks_for_confirmation_first(self):
        response = self._run_action(self.agent.pk)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "stops working immediately")
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.token_hash, hash_token(self.old_token))

    def test_confirmed_rotation_shows_new_token_once_without_cookies(self):
        response = self._run_action(self.agent.pk, confirm=True)
        self.assertEqual(response.status_code, 200)
        raw_token = response.context["raw_token"]
        self.assertContains(response, raw_token)
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.token_hash, hash_token(raw_token))
        self.assertNotIn(raw_token, self.agent.token_hash)
        self.assert_token_not_persisted_client_side(response, raw_token)
        self.assert_no_store(response)
        self.assertNotIn("messages", response.cookies)

        # The old token stops working immediately; the new one works.
        self.assertEqual(self._heartbeat_status(self.old_token), 401)
        self.assertEqual(self._heartbeat_status(raw_token), 200)

    def test_rotation_is_audited_without_the_token(self):
        response = self._run_action(self.agent.pk, confirm=True)
        raw_token = response.context["raw_token"]
        entry = LogEntry.objects.get(object_id=str(self.agent.pk), action_flag=CHANGE)
        self.assertIn("Regenerated authentication token", entry.get_change_message())
        self.assertNotIn(raw_token, entry.change_message)

    def test_multiple_agents_are_refused(self):
        other_server = Server.objects.create(name="tok-host-2", hostname="tok2.local")
        other, _ = create_agent(server=other_server, name="tok-agent-2")
        before = set(Agent.objects.values_list("token_hash", flat=True))
        response = self._run_action(self.agent.pk, other.pk, confirm=True)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(set(Agent.objects.values_list("token_hash", flat=True)), before)

    def test_view_only_staff_cannot_regenerate_tokens(self):
        viewer = get_user_model().objects.create_user("viewer", password="x", is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(codename="view_agent"))
        self.client.force_login(viewer)
        changelist = self.client.get(CHANGELIST)
        self.assertEqual(changelist.status_code, 200)
        action_form = changelist.context["action_form"]
        offered = [] if action_form is None else dict(action_form.fields["action"].choices)
        self.assertNotIn("regenerate_token", offered)

        response = self._run_action(self.agent.pk, confirm=True)
        self.assertNotIn("raw_token", response.context or {})
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.token_hash, hash_token(self.old_token))
        self.assertEqual(self._heartbeat_status(self.old_token), 200)


class AddAgentInAdminTests(AdminTokenTestCase):
    def _add(self, name, server):
        return self.client.post(
            ADD,
            {"server": str(server.pk), "name": name, "enabled": "on", "agent_version": ""},
        )

    def test_added_agent_gets_a_working_token_shown_once(self):
        server = Server.objects.create(name="new-host", hostname="new.local")
        response = self._add("new-agent", server)
        self.assertEqual(response.status_code, 200)
        raw_token = response.context["raw_token"]
        agent = Agent.objects.get(server=server)
        self.assertEqual(agent.token_hash, hash_token(raw_token))
        self.assert_token_not_persisted_client_side(response, raw_token)
        self.assert_no_store(response)
        self.assertEqual(self._heartbeat_status(raw_token), 200)

    def test_agents_added_in_admin_do_not_share_an_empty_token_hash(self):
        first = Server.objects.create(name="host-a", hostname="a.local")
        second = Server.objects.create(name="host-b", hostname="b.local")
        self.assertEqual(self._add("agent-a", first).status_code, 200)
        self.assertEqual(self._add("agent-b", second).status_code, 200)
        hashes = list(Agent.objects.values_list("token_hash", flat=True))
        self.assertNotIn("", hashes)
        self.assertEqual(len(hashes), len(set(hashes)))
