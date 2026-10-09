from datetime import timedelta
from io import StringIO

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.infrastructure.docker_reports import apply_docker_report
from apps.infrastructure.models import DockerContainer, Server
from apps.infrastructure.tests.test_docker_sync import container, report


@override_settings(SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS=30)
class AbsentContainerCleanupTests(TestCase):
    def setUp(self):
        self.server = Server.objects.create(name="clean", hostname="clean.local")
        self.now = timezone.now()

    def _container(self, index, *, present, age_days):
        seen = self.now - timedelta(days=age_days)
        return DockerContainer.objects.create(
            server=self.server, container_id=f"{index:064x}", name=f"c{index}",
            image="img", state="exited", health="none", present=present,
            last_seen_at=seen, received_at=seen,
        )

    def _purge(self, **options):
        out = StringIO()
        call_command("purge_absent_docker_containers", stdout=out, stderr=out, **options)
        return out.getvalue()

    def test_deletes_only_long_absent_containers(self):
        old_absent = self._container(1, present=False, age_days=31)
        recent_absent = self._container(2, present=False, age_days=29)
        old_present = self._container(3, present=True, age_days=400)
        output = self._purge()
        self.assertIn("Deleted 1 absent container(s)", output)
        remaining = set(DockerContainer.objects.values_list("pk", flat=True))
        self.assertEqual(remaining, {recent_absent.pk, old_present.pk})
        self.assertFalse(DockerContainer.objects.filter(pk=old_absent.pk).exists())

    def test_present_containers_are_never_deleted(self):
        self._container(1, present=True, age_days=10_000)
        self._purge(days=1)
        self.assertEqual(DockerContainer.objects.count(), 1)

    def test_docker_outage_never_makes_containers_eligible(self):
        apply_docker_report(
            self.server, report([container(1)]),
            received_at=self.now - timedelta(days=90),
        )
        for days_ago in (60, 30, 1):
            apply_docker_report(
                self.server, report(status="unavailable"),
                received_at=self.now - timedelta(days=days_ago),
            )
        self._purge(days=7)
        row = DockerContainer.objects.get()
        self.assertTrue(row.present)

    def test_batches_and_dry_run(self):
        for index in range(7):
            self._container(index, present=False, age_days=40)
        self.assertIn("Would delete 7 absent container(s)", self._purge(dry_run=True))
        self.assertEqual(DockerContainer.objects.count(), 7)
        output = self._purge(batch_size=3)
        self.assertIn("Deleted 7 absent container(s)", output)
        self.assertIn("in 3 batch(es)", output)
        self.assertFalse(DockerContainer.objects.exists())

    def test_reappearing_container_after_cleanup_is_recreated(self):
        apply_docker_report(
            self.server, report([container(1)]), received_at=self.now - timedelta(days=60)
        )
        apply_docker_report(
            self.server, report([]), received_at=self.now - timedelta(days=59)
        )
        self._purge()
        self.assertFalse(DockerContainer.objects.exists())
        apply_docker_report(self.server, report([container(1)]))
        self.assertTrue(DockerContainer.objects.get().present)

    def test_invalid_options_are_refused(self):
        self._container(1, present=False, age_days=40)
        self.assertIn("positive integer", self._purge(days=0))
        self.assertIn("--batch-size must be between", self._purge(batch_size=0))
        self.assertEqual(DockerContainer.objects.count(), 1)
