from django.apps import AppConfig
from django.db.models.signals import post_migrate


class ConsoleConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.console"
    label = "console"
    verbose_name = "Console"

    def ready(self) -> None:
        from apps.console.groups import ensure_console_groups

        post_migrate.connect(
            ensure_console_groups,
            sender=self,
            dispatch_uid="apps.console.ensure_console_groups",
        )
