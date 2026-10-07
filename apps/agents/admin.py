from django.contrib import admin, messages

from apps.agents.models import Agent
from apps.agents.tokens import generate_token, hash_token


@admin.register(Agent)
class AgentAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "server",
        "enabled",
        "agent_version",
        "last_seen_at",
        "created_at",
    )
    list_filter = ("enabled",)
    search_fields = ("name", "server__name", "server__hostname")
    readonly_fields = ("id", "token_hash", "last_seen_at", "created_at", "updated_at")
    raw_id_fields = ("server",)
    actions = ("regenerate_token",)
    fieldsets = (
        (
            None,
            {
                "fields": ("id", "server", "name", "enabled", "agent_version"),
            },
        ),
        (
            "Credentials",
            {
                "fields": ("token_hash",),
                "description": (
                    "Only the token hash is stored. Create agents with "
                    "`python manage.py create_agent` or use the regenerate "
                    "token admin action. The raw token is shown once."
                ),
            },
        ),
        (
            "Activity",
            {
                "fields": ("last_seen_at", "created_at", "updated_at"),
            },
        ),
    )

    @admin.action(description="Regenerate authentication token")
    def regenerate_token(self, request, queryset):
        if queryset.count() != 1:
            self.message_user(
                request,
                "Select exactly one agent to regenerate its token.",
                level=messages.ERROR,
            )
            return

        agent = queryset.get()
        raw_token = generate_token()
        agent.token_hash = hash_token(raw_token)
        agent.save(update_fields=["token_hash", "updated_at"])
        self.message_user(
            request,
            (
                f"New token for '{agent.name}' (copy now; it will not be shown "
                f"again): {raw_token}"
            ),
            level=messages.WARNING,
        )
