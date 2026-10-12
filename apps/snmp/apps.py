from django.apps import AppConfig


class SnmpAppConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.snmp"
    label = "snmp"
    verbose_name = "SNMP"
