"""The admin pages of data that other parts of Sentinel write: shown, never added, changed or deleted by hand."""

from django.contrib import admin
from django.test import RequestFactory, TestCase

from apps.alerts import admin as alerts_admin
from apps.alerts.models import (
    AlertEngineHeartbeat,
    AlertEvaluationState,
    ConfigurationEvent,
    Incident,
    Notification,
    NotifierHeartbeat,
    TestEmailRequest,
)
from apps.core.admin import ReadOnlyAdmin
from apps.snmp import admin as snmp_admin
from apps.snmp.models import DevicePoll, DeviceSnmpState, Interface, InterfaceSample
from apps.web import admin as web_admin
from apps.web.models import DomainVerification, DomainVerifierHeartbeat, MonitoredDomain

READ_ONLY = (
    Incident,
    AlertEvaluationState,
    AlertEngineHeartbeat,
    Notification,
    TestEmailRequest,
    NotifierHeartbeat,
    ConfigurationEvent,
    MonitoredDomain,
    DomainVerification,
    DomainVerifierHeartbeat,
    DeviceSnmpState,
    Interface,
    DevicePoll,
    InterfaceSample,
)


class ReadOnlyAdminTests(TestCase):
    def test_one_definition_is_shared(self):
        self.assertIs(alerts_admin.ReadOnlyAdmin, ReadOnlyAdmin)
        self.assertIs(web_admin.ReadOnlyAdmin, ReadOnlyAdmin)
        # SNMP history keeps its estimated counts on top of it.
        self.assertTrue(issubclass(snmp_admin.ReadOnlyAdmin, ReadOnlyAdmin))
        self.assertIs(snmp_admin.ReadOnlyAdmin.paginator, snmp_admin.EstimatedCountPaginator)
        self.assertFalse(snmp_admin.ReadOnlyAdmin.show_full_result_count)

    def test_nothing_can_be_added_changed_or_deleted_even_by_a_superuser(self):
        from django.contrib.auth import get_user_model

        request = RequestFactory().get("/admin/")
        request.user = get_user_model().objects.create_superuser("root", password="x-long-unusual-password-1")
        for model in READ_ONLY:
            with self.subTest(model=model.__name__):
                model_admin = admin.site._registry[model]
                self.assertIsInstance(model_admin, ReadOnlyAdmin)
                self.assertFalse(model_admin.has_add_permission(request))
                self.assertFalse(model_admin.has_change_permission(request))
                self.assertFalse(model_admin.has_delete_permission(request))
                self.assertTrue(model_admin.has_view_permission(request))
