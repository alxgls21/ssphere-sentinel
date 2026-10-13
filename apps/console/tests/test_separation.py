"""Agent authentication and console authentication share nothing."""

import json

from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext

from apps.agents.services import create_agent
from apps.console.tests.helpers import make_user, signed_in_client
from apps.infrastructure.models import Server

SCOPE = "/api/v1/console/scope/"
SESSION = "/api/v1/console/session/"
HEARTBEAT = "/api/v1/agent/heartbeat/"


class SeparationTests(TestCase):
    def setUp(self):
        server = Server.objects.create(name="host", hostname="host.local")
        self.agent, self.token = create_agent(server=server, name="host-agent")

    def test_an_agent_token_does_not_open_the_console(self):
        for url in (SCOPE, SESSION):
            response = Client().get(url, HTTP_AUTHORIZATION=f"Bearer {self.token}")
            self.assertNotEqual(response.status_code, 403)
            if url == SCOPE:
                self.assertEqual(response.status_code, 401)
            else:
                self.assertFalse(response.json()["authenticated"])

    def test_an_agent_token_cannot_sign_in_either(self):
        client = Client()
        for value in (self.token, "Bearer " + self.token, "Basic " + self.token):
            response = client.get(SCOPE, HTTP_AUTHORIZATION=value)
            self.assertEqual(response.status_code, 401)

    def test_console_views_never_look_up_agents(self):
        client = Client()
        with CaptureQueriesContext(connection) as captured:
            client.get(SCOPE, HTTP_AUTHORIZATION=f"Bearer {self.token}")
            client.get(SESSION, HTTP_AUTHORIZATION=f"Bearer {self.token}")
        self.assertFalse([q for q in captured if "agents_agent" in q["sql"]])

    def test_an_agent_token_does_not_help_a_signed_in_user_either(self):
        user = make_user("viewer")  # no grants
        client = signed_in_client(user)
        other_token = f"Bearer {self.token}"
        self.assertEqual(client.get(SCOPE, HTTP_AUTHORIZATION=other_token).json(), {"customers": [], "sites": []})

    def test_a_console_session_is_not_an_agent_credential(self):
        for user in (make_user("viewer"), make_user("root", superuser=True)):
            client = signed_in_client(user)
            response = client.post(HEARTBEAT, data=json.dumps({}), content_type="application/json")
            self.assertEqual(response.status_code, 401, user)
            self.assertEqual(response.json(), {"detail": "Authentication credentials were not provided."})

    def test_a_console_session_cannot_pose_as_an_agent_by_header(self):
        client = signed_in_client(make_user("viewer"))
        response = client.post(
            HEARTBEAT, data="{}", content_type="application/json", HTTP_AUTHORIZATION="Bearer not-a-real-token"
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"detail": "Invalid authentication credentials."})

    def test_the_agent_heartbeat_is_unchanged_by_the_console(self):
        response = Client().post(
            HEARTBEAT, data="{}", content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {self.token}"
        )
        self.assertEqual((response.status_code, response.json()), (200, {"status": "ok"}))

    def test_agent_endpoints_stay_csrf_exempt_while_console_posts_are_not(self):
        enforcing = Client(enforce_csrf_checks=True)
        ok = enforcing.post(HEARTBEAT, data="{}", content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {self.token}")
        self.assertEqual(ok.status_code, 200)
        refused = enforcing.post("/api/v1/console/auth/login/", data="{}", content_type="application/json")
        self.assertEqual(refused.status_code, 403)

    def test_neither_api_imports_the_others_authentication_code(self):
        """Import graph: apps.console never imports apps.agents (or reads Authorization), and vice versa."""
        import ast
        from pathlib import Path

        import apps.agents
        import apps.console

        def imported_modules(root: Path):
            for path in root.rglob("*.py"):
                if "tests" in path.parts or "migrations" in path.parts:
                    continue
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        yield path, [alias.name for alias in node.names]
                    elif isinstance(node, ast.ImportFrom):
                        yield path, [node.module or ""]

        console_root = Path(apps.console.__file__).parent
        agents_root = Path(apps.agents.__file__).parent
        for path, modules in imported_modules(console_root):
            for module in modules:
                self.assertFalse(module.startswith("apps.agents"), f"{path.name} imports {module}")
        for path, modules in imported_modules(agents_root):
            for module in modules:
                self.assertFalse(module.startswith("apps.console"), f"{path.name} imports {module}")
        # ...and no string constant that could name the header, however it is read
        # (META["HTTP_AUTHORIZATION"], request.headers["Authorization"], getattr(...)).
        for path in console_root.glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                # (header names have no spaces; this skips docstrings and messages)
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and " " not in node.value:
                    self.assertNotIn("authorization", node.value.lower().replace("_", "-"), f"{path.name}: {node.value!r}")
