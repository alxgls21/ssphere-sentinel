"""A container that crashed: how its last run ended, from the agent's report to the console's status and the
alert rules (``exit_code``, ``oom_killed`` and ``finished_at`` of ``DockerContainer``)."""

from __future__ import annotations

import json
from datetime import timedelta

from django.test import Client
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_docker_api import valid_container, valid_docker
from apps.alerts.conditions import reasons_for
from apps.console.health import STOP_EXIT_CODES, annotate_containers
from apps.console.serializers import iso
from apps.console.tests.helpers import ConsoleDataTestCase, make_container, make_docker_host, make_server, make_user
from apps.infrastructure.models import DockerContainer, Server

EXITED = DockerContainer.State.EXITED


class CrashedContainerTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.server = make_server("docker-host", now=self.now)
        make_docker_host(self.server, now=self.now)
        self.user = make_user("ops", all_customers=True)

    def container(self, name, *, state=EXITED, exit_code=None, oom_killed=None, finished_ago=60):
        row = make_container(self.server, name, now=self.now, state=state)
        row.exit_code, row.oom_killed = exit_code, oom_killed
        row.finished_at = None if finished_ago is None else self.now - timedelta(seconds=finished_ago)
        row.save()
        return row

    def items(self):
        body = self.get(self.user, "containers/", pageSize=200).json()
        return {item["container"]["name"]: item for item in body["items"]}

    def test_a_crash_is_critical_and_a_stop_is_not(self):
        cases = {
            # name: (state, exit code, killed for memory) -> (status, reason)
            "finished": (EXITED, 0, False, "idle", "stopped"),
            "ctrl-c": (EXITED, 130, False, "idle", "stopped"),
            "stop-timeout": (EXITED, 137, False, "idle", "stopped"),
            "stopped": (EXITED, 143, False, "idle", "stopped"),
            "error": (EXITED, 1, False, "critical", "crashed"),
            "segfault": (EXITED, 139, None, "critical", "crashed"),
            "out-of-memory": (EXITED, 137, True, "critical", "crashed"),
            "out-of-memory-no-code": (EXITED, None, True, "critical", "crashed"),
            # An agent before 0.9.5 says nothing of the exit: as before, a stop.
            "old-agent": (EXITED, None, None, "idle", "stopped"),
            # Running again after a crash: what counts is now.
            "recovered": (DockerContainer.State.RUNNING, 1, False, "healthy", "running"),
            "created": (DockerContainer.State.CREATED, None, None, "idle", "stopped"),
            "dead": (DockerContainer.State.DEAD, 1, False, "critical", "dead"),
        }
        for name, (state, code, oom, *_rest) in cases.items():
            self.container(name, state=state, exit_code=code, oom_killed=oom)
        items = self.items()
        reasons = {
            row["name"]: row["health_reason"]
            for row in annotate_containers(DockerContainer.objects.all(), self.now).values("name", "health_reason")
        }
        for name, (_state, _code, _oom, status, reason) in cases.items():
            with self.subTest(name=name):
                self.assertEqual((items[name]["status"], reasons[name]), (status, reason))
        self.assertEqual(STOP_EXIT_CODES, (0, 130, 137, 143))

    def test_the_console_shows_how_it_ended_while_the_host_is_current(self):
        self.container("worker", exit_code=1, oom_killed=False, finished_ago=300)
        container = self.items()["worker"]["container"]
        self.assertEqual((container["state"], container["exitCode"], container["oomKilled"]), ("exited", 1, False))
        self.assertEqual(container["finishedAt"], iso(self.now - timedelta(seconds=300)))
        # The host went silent: what is stored is last-known, not current.
        Server.objects.filter(pk=self.server.pk).update(last_seen_at=self.now - timedelta(days=1))
        item = self.items()["worker"]
        self.assertEqual((item["status"], item["container"]["state"]), ("unknown", "unknown"))
        self.assertEqual((item["container"]["exitCode"], item["container"]["oomKilled"], item["container"]["finishedAt"]), (None, None, None))

    def test_a_rule_can_fire_on_a_crash(self):
        self.assertIn("crashed", reasons_for("container", "critical"))
        self.assertIn("crashed", reasons_for("container", "warning"))
        self.assertNotIn("stopped", reasons_for("container", "critical"))
        options = self.get(make_user("admin", superuser=True), "alert-rules/options/").json()
        self.assertIn("crashed", json.dumps(options))


class ExitReportTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.server = Server.objects.create(name="docker-host", hostname="docker.local")
        self.agent, self.token = create_agent(server=self.server, name="agent")
        self.client_ = Client()

    def report(self, *containers, collected_at=None):
        body = {"docker": valid_docker(containers=list(containers),
                                       collected_at=(collected_at or timezone.now()).isoformat())}
        return self.client_.post(reverse("agent-heartbeat"), data=json.dumps(body), content_type="application/json",
                                 HTTP_AUTHORIZATION=f"Bearer {self.token}").json()

    def test_how_a_run_ended_is_stored_and_updated(self):
        finished = timezone.now() - timedelta(minutes=5)
        answer = self.report(valid_container(state="exited", exit_code=1, oom_killed=False, finished_at=finished.isoformat()))
        self.assertEqual(answer["docker"], "accepted")
        row = DockerContainer.objects.get()
        self.assertEqual((row.exit_code, row.oom_killed, row.finished_at), (1, False, finished))
        # Restarted, then killed for memory: the next report says so.
        self.report(valid_container(state="exited", exit_code=137, oom_killed=True, finished_at=timezone.now().isoformat()),
                    collected_at=timezone.now() + timedelta(seconds=1))
        row.refresh_from_db()
        self.assertEqual((row.exit_code, row.oom_killed), (137, True))

    def test_an_agent_that_does_not_send_them_is_accepted(self):
        self.assertEqual(self.report(valid_container(state="exited"))["docker"], "accepted")
        row = DockerContainer.objects.get()
        self.assertEqual((row.exit_code, row.oom_killed, row.finished_at), (None, None, None))
        self.report(valid_container(state="exited", exit_code=None, oom_killed=None, finished_at=None),
                    collected_at=timezone.now() + timedelta(seconds=1))
        self.assertEqual(DockerContainer.objects.get().exit_code, None)

    def test_what_is_not_a_number_or_a_flag_is_refused(self):
        for bad in ({"exit_code": "1"}, {"exit_code": True}, {"exit_code": 1.5}, {"exit_code": 2**31},
                    {"oom_killed": "yes"}, {"oom_killed": 0}, {"finished_at": "yesterday"}):
            with self.subTest(bad=bad):
                answer = self.report(valid_container(state="exited", **bad))
                self.assertEqual(answer["docker"], "rejected")
        self.assertFalse(DockerContainer.objects.exists())
