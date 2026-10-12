from datetime import timedelta

from django.apps import apps
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import TestCase
from django.utils import timezone

from apps.agents.models import Agent
from apps.snmp.models import (
    DevicePoll,
    DeviceSnmpState,
    Interface,
    InterfaceSample,
    SnmpConfig,
)
from apps.snmp.tests.helpers import ingest, interface, make_agent, make_device, poll


class SnmpConfigTests(TestCase):
    def setUp(self):
        self.agent, _token = make_agent()
        self.device = make_device(self.agent, configured=False)

    def make(self, **overrides):
        values = {"device": self.device, "credential_profile": "core"}
        values.update(overrides)
        return SnmpConfig(**values)

    def test_defaults_match_the_agreed_policy(self):
        config = self.make()
        config.save()
        self.assertEqual(
            (config.version, config.port, config.poll_interval_seconds, config.timeout_seconds, config.retries),
            ("3", 161, 300, 5, 1),
        )
        self.assertEqual(self.device.snmp_config, config)

    def test_only_v2c_and_v3_are_supported(self):
        self.assertEqual({value for value, _label in SnmpConfig.Version.choices}, {"2c", "3"})
        for version in ("1", "v1", "2", ""):
            with self.subTest(version=version):
                with self.assertRaises(ValidationError):
                    self.make(version=version).save()

    def test_limits_are_enforced(self):
        invalid = (
            {"port": 0},
            {"port": 65536},
            {"poll_interval_seconds": 29},
            {"poll_interval_seconds": 86401},
            {"timeout_seconds": 0},
            {"timeout_seconds": 61},
            {"retries": 6},
        )
        for overrides in invalid:
            with self.subTest(**overrides):
                with self.assertRaises(ValidationError):
                    self.make(**overrides).save()

    def test_requests_must_fit_into_the_poll_interval(self):
        with self.assertRaisesMessage(ValidationError, "shorter than the poll interval"):
            self.make(poll_interval_seconds=30, timeout_seconds=15, retries=1).save()
        self.make(poll_interval_seconds=30, timeout_seconds=5, retries=1).save()

    def test_credential_profile_is_only_a_label(self):
        for bad in ("", "has space", "semi;colon", "-leading", "a" * 65, "pass\nword"):
            with self.subTest(profile=bad):
                with self.assertRaises(ValidationError):
                    self.make(credential_profile=bad).save()
        self.make(credential_profile="core-switches_v3.eu").save()

    def test_deleting_the_device_removes_its_configuration(self):
        self.make().save()
        self.device.delete()
        self.assertFalse(SnmpConfig.objects.exists())


class NoCredentialsInTheDatabaseTests(TestCase):
    SECRETISH = ("community", "password", "passphrase", "secret", "auth_key", "priv_key", "authkey", "privkey", "token")

    def test_no_model_has_a_field_that_could_hold_a_secret(self):
        for app_label in ("snmp", "inventory"):
            for model in apps.get_app_config(app_label).get_models():
                for field in model._meta.get_fields():
                    with self.subTest(model=model.__name__, field=field.name):
                        self.assertFalse(
                            any(word in field.name.lower() for word in self.SECRETISH),
                            f"{model.__name__}.{field.name} looks like a credential",
                        )

    def test_unknown_payload_fields_are_never_stored(self):
        agent, _token = make_agent()
        device = make_device(agent)
        secret = "TopSecretCommunityString-9f3a"
        payload = poll(device, [interface(1, community=secret, auth_key=secret)], community=secret, priv_key=secret)
        payload["system"]["community"] = secret
        payload["interfaces"][0]["counters"]["community"] = secret
        result = ingest(agent, [payload])
        self.assertEqual(result.created, 1)
        for model in list(apps.get_app_config("snmp").get_models()) + list(apps.get_app_config("inventory").get_models()):
            for row in model.objects.values():
                self.assertNotIn(secret, repr(row), model.__name__)


class DatabaseConstraintTests(TestCase):
    """The database rejects invalid rows even when model validation is bypassed."""

    def setUp(self):
        self.agent, _token = make_agent()
        self.device = make_device(self.agent)
        self.interface = Interface.objects.create(
            device=self.device, if_index=1, name="Gi0/1", admin_status=1, oper_status=1
        )
        self.now = timezone.now()

    def sample(self, **overrides):
        values = {
            "interface": self.interface,
            "measured_at": self.now,
            "admin_status": 1,
            "oper_status": 1,
            "octets_bits": 64,
            "delta_state": "first",
        }
        values.update(overrides)
        return InterfaceSample(**values)

    def assert_rejected(self, sample):
        with self.assertRaises(IntegrityError), transaction.atomic():
            InterfaceSample.objects.bulk_create([sample])

    def test_valid_sample_is_accepted(self):
        InterfaceSample.objects.bulk_create([self.sample()])

    def test_status_and_counter_width_must_be_in_range(self):
        for overrides in (
            {"admin_status": 0},
            {"admin_status": 4},
            {"oper_status": 8},
            {"octets_bits": 16},
        ):
            with self.subTest(**overrides):
                self.assert_rejected(self.sample(**overrides))

    def test_counters_cannot_be_negative(self):
        self.assert_rejected(self.sample(in_octets=-1))

    def test_deltas_exist_only_when_the_state_says_they_are_valid(self):
        for state in ("first", "reboot", "reset", "gap"):
            with self.subTest(state=state):
                self.assert_rejected(self.sample(delta_state=state, in_octets_delta=1, interval_seconds=300))
        for state in ("ok", "speed_changed"):
            with self.subTest(state=state):
                # valid deltas need an interval
                self.assert_rejected(self.sample(delta_state=state, in_octets_delta=1, interval_seconds=None))
                self.assert_rejected(self.sample(delta_state=state, in_octets_delta=1, interval_seconds=0))
        InterfaceSample.objects.bulk_create(
            [self.sample(delta_state="ok", in_octets_delta=1, interval_seconds=300)]
        )

    def test_one_sample_per_interface_and_time(self):
        InterfaceSample.objects.bulk_create([self.sample()])
        self.assert_rejected(self.sample())

    def test_poll_error_requires_an_unreachable_device(self):
        import uuid

        def new_poll(**overrides):
            values = {
                "id": uuid.uuid4(),
                "device": self.device,
                "measured_at": self.now,
                "received_at": self.now,
                "reachable": True,
            }
            values.update(overrides)
            return DevicePoll(**values)

        with self.assertRaises(IntegrityError), transaction.atomic():
            DevicePoll.objects.bulk_create([new_poll(error="timeout")])
        DevicePoll.objects.bulk_create([new_poll(reachable=False, error="timeout")])

    def test_one_poll_per_device_and_time(self):
        import uuid

        base = {"device": self.device, "measured_at": self.now, "received_at": self.now, "reachable": True}
        DevicePoll.objects.bulk_create([DevicePoll(id=uuid.uuid4(), **base)])
        with self.assertRaises(IntegrityError), transaction.atomic():
            DevicePoll.objects.bulk_create([DevicePoll(id=uuid.uuid4(), **base)])

    def test_one_interface_per_device_and_index(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            Interface.objects.create(device=self.device, if_index=1, name="dup", admin_status=1, oper_status=1)


class HistoryProtectionTests(TestCase):
    def setUp(self):
        self.agent, _token = make_agent()
        self.device = make_device(self.agent)
        ingest(self.agent, [poll(self.device)])

    def test_device_with_history_cannot_be_deleted(self):
        with self.assertRaises(ProtectedError):
            self.device.delete()
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_interface_with_samples_cannot_be_deleted(self):
        with self.assertRaises(ProtectedError):
            Interface.objects.get(if_index=1).delete()

    def test_device_without_history_is_deleted_with_its_interfaces_and_state(self):
        agent, _token = make_agent("other")
        device = make_device(agent, "spare")
        Interface.objects.create(device=device, if_index=1, name="Gi0/1", admin_status=1, oper_status=1)
        DeviceSnmpState.objects.create(device=device)
        device.delete()
        self.assertFalse(Interface.objects.filter(device_id=device.pk).exists())
        self.assertFalse(DeviceSnmpState.objects.filter(pk=device.pk).exists())

    def test_deleting_the_agent_keeps_the_history_without_rewriting_it(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as captured:
            self.agent.delete()
        self.assertEqual(Agent.objects.count(), 0)
        self.assertEqual((DevicePoll.objects.count(), InterfaceSample.objects.count()), (1, 1))
        # History rows carry no reference to the agent, so deleting an agent
        # never scans or rewrites them (it would take minutes at millions of rows).
        touched = [q["sql"] for q in captured if "snmp_" in q["sql"] and q["sql"].startswith(("UPDATE", "DELETE"))]
        self.assertEqual(touched, [])
        self.device.refresh_from_db()
        self.assertIsNone(self.device.assigned_agent)

    def test_history_is_older_than_a_day_ago_irrelevant_to_protection(self):
        # Protection does not depend on age: only the retention command deletes.
        DevicePoll.objects.update(measured_at=timezone.now() - timedelta(days=400))
        with self.assertRaises(ProtectedError):
            self.device.delete()
