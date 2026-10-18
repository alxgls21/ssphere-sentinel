from django.apps import AppConfig


class AlertsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.alerts"
    label = "alerts"
    verbose_name = "Alerts"

    def ready(self) -> None:
        from django.db.models.signals import pre_delete

        from apps.alerts.audit import subscription_deleted_with_account
        from apps.alerts.models import NotificationSubscription

        pre_delete.connect(
            subscription_deleted_with_account, sender=NotificationSubscription, dispatch_uid="alerts-subscription-audit"
        )
