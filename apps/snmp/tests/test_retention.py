import json
import uuid
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.snmp.models import DevicePoll, Interface, InterfaceSample
from apps.snmp.tests.helpers import make_agent, make_device, poll, report

FROZEN_NOW = timezone.now()


def add_history(device, interface, ages, *, polls=True):
    """Samples ``ages`` old (timedeltas) for ``interface``, and the device polls.

    A device is polled once per instant: pass ``polls=False`` when another
    call for the same device already created polls at the same ages.
    """
    if polls:
        DevicePoll.objects.bulk_create(
            DevicePoll(
                id=uuid.uuid4(),
                device=device,
                measured_at=FROZEN_NOW - age,
                received_at=FROZEN_NOW - age,
                reachable=True,
            )
            for age in ages
        )
    InterfaceSample.objects.bulk_create(
        InterfaceSample(
            interface=interface,
            measured_at=FROZEN_NOW - age,
            admin_status=1,
            oper_status=1,
            octets_bits=64,
            delta_state="first",
        )
        for age in ages
    )


def make_interface(device, if_index, **overrides):
    values = {"name": f"Gi0/{if_index}", "admin_status": 1, "oper_status": 1}
    values.update(overrides)
    return Interface.objects.create(device=device, if_index=if_index, **values)


@override_settings(SENTINEL_SNMP_RETENTION_DAYS=7)
@patch("django.utils.timezone.now", return_value=FROZEN_NOW)
class PurgeSnmpDataTests(TestCase):
    def setUp(self):
        self.agent, self.token = make_agent()
        self.device = make_device(self.agent)
        self.interface = make_interface(self.device, 1)

    def purge(self, **options):
        out = StringIO()
        call_command("purge_snmp_data", stdout=out, stderr=out, **options)
        return out.getvalue()

    def test_deletes_only_history_older_than_the_retention_period(self, _now):
        add_history(self.device, self.interface, [timedelta(days=30), timedelta(days=8), timedelta(days=6), timedelta(hours=1)])
        output = self.purge()
        self.assertIn("Deleted 2 interface sample(s)", output)
        self.assertIn("2 poll(s)", output)
        self.assertEqual(InterfaceSample.objects.count(), 2)
        self.assertEqual(DevicePoll.objects.count(), 2)
        self.assertTrue(all(s.measured_at >= FROZEN_NOW - timedelta(days=7) for s in InterfaceSample.objects.all()))

    def test_the_cutoff_is_exclusive(self, _now):
        add_history(self.device, self.interface, [timedelta(days=7)])
        self.purge()
        self.assertEqual((InterfaceSample.objects.count(), DevicePoll.objects.count()), (1, 1))

    def test_current_interfaces_are_kept_even_without_samples(self, _now):
        self.purge()
        self.assertTrue(Interface.objects.filter(pk=self.interface.pk).exists())

    def test_absent_interfaces_are_removed_once_their_history_is_gone(self, _now):
        gone = make_interface(self.device, 2, present=False)
        recent = make_interface(self.device, 3, present=False)
        still_old = make_interface(self.device, 4, present=False)
        add_history(self.device, gone, [timedelta(days=30)])
        add_history(self.device, recent, [timedelta(days=30), timedelta(days=1)], polls=False)
        add_history(self.device, still_old, [])
        self.purge()
        remaining = set(Interface.objects.values_list("if_index", flat=True))
        self.assertEqual(remaining, {1, 3})  # 3 still has a recent sample; 2 and 4 are gone

    def test_dry_run_counts_and_deletes_nothing(self, _now):
        gone = make_interface(self.device, 2, present=False)
        add_history(self.device, self.interface, [timedelta(days=30), timedelta(days=1)])
        add_history(self.device, gone, [timedelta(days=30)], polls=False)
        output = self.purge(dry_run=True)
        self.assertIn("Would delete 2 interface sample(s), 1 poll(s) and 1 absent interface(s)", output)
        self.assertEqual((InterfaceSample.objects.count(), DevicePoll.objects.count(), Interface.objects.count()), (3, 2, 2))

    def test_deletes_in_batches(self, _now):
        add_history(self.device, self.interface, [timedelta(days=30 + i) for i in range(7)])
        output = self.purge(batch_size=3)
        self.assertIn("Deleted 7 interface sample(s) in 3 batch(es)", output)
        self.assertIn("7 poll(s) in 3 batch(es)", output)
        self.assertFalse(InterfaceSample.objects.exists())

    def test_days_option_overrides_the_setting(self, _now):
        add_history(self.device, self.interface, [timedelta(days=3), timedelta(days=1)])
        self.purge(days=2)
        self.assertEqual(InterfaceSample.objects.count(), 1)

    def test_invalid_options_are_refused_and_delete_nothing(self, _now):
        add_history(self.device, self.interface, [timedelta(days=30)])
        for options, message in (
            ({"days": 0}, "positive integer"),
            ({"days": -1}, "positive integer"),
            ({"batch_size": 0}, "--batch-size must be between"),
            ({"batch_size": 100_001}, "--batch-size must be between"),
        ):
            with self.subTest(**options), self.assertRaisesMessage(CommandError, message):
                self.purge(**options)
        self.assertEqual(InterfaceSample.objects.count(), 1)

    def test_a_device_can_be_deleted_after_its_history_has_been_purged(self, _now):
        add_history(self.device, self.interface, [timedelta(days=30)])
        self.device.enabled = False
        self.device.save()
        self.purge()
        self.device.delete()
        self.assertFalse(Interface.objects.filter(device_id=self.device.pk).exists())

    def test_heartbeats_never_trigger_retention(self, _now):
        add_history(self.device, self.interface, [timedelta(days=60)])
        response = Client().post(
            reverse("agent-heartbeat"),
            data="{}",
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.token}",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(InterfaceSample.objects.count(), 1)

    def test_polls_older_than_the_window_cannot_be_ingested_and_purged_in_a_loop(self, _now):
        # Ingest rejects polls older than min(max-age, retention), so rows that
        # would be purged immediately are never stored.
        payload = poll(self.device, minutes=8 * 24 * 60)
        response = Client().post(
            reverse("agent-heartbeat"),
            data=json.dumps({"snmp": report([payload])}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.token}",
        )
        self.assertEqual(response.json()["snmp"], "rejected")
        self.assertFalse(DevicePoll.objects.exists())
