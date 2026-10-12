from django.contrib import admin, messages
from django.contrib.admin import helpers
from django.template.response import TemplateResponse
from django.utils.cache import add_never_cache_headers

from apps.agents.models import Agent
from apps.agents.services import assign_new_token, rotate_token

TOKEN_PAGE_TEMPLATE = "admin/agents/agent/token.html"
CONFIRM_TEMPLATE = "admin/agents/agent/regenerate_token_confirmation.html"


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
                    "Only the token hash is stored. A token is generated when the "
                    "agent is added (here or with `python manage.py create_agent`) "
                    "and by the regenerate token admin action. The raw token is "
                    "shown once."
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

    # Raw tokens are rendered into a single no-store response page. They never
    # go through the messages framework, whose cookie is signed but not
    # encrypted, and are never put in the session.

    def save_model(self, request, obj, form, change):
        if not change:
            request._new_agent_token = assign_new_token(obj)
        super().save_model(request, obj, form, change)

    def response_add(self, request, obj, post_url_continue=None):
        raw_token = getattr(request, "_new_agent_token", None)
        if raw_token is None:
            return super().response_add(request, obj, post_url_continue)
        return self._token_page(request, obj, raw_token, title="Agent added")

    @admin.action(
        description="Regenerate authentication token",
        permissions=["change"],
    )
    def regenerate_token(self, request, queryset):
        if queryset.count() != 1:
            self.message_user(
                request,
                "Select exactly one agent to regenerate its token.",
                level=messages.ERROR,
            )
            return None

        agent = queryset.select_related("server").get()
        if request.POST.get("confirm") != "yes":
            return TemplateResponse(
                request,
                CONFIRM_TEMPLATE,
                {
                    **self._page_context(request, agent, "Regenerate authentication token"),
                    "action_checkbox_name": helpers.ACTION_CHECKBOX_NAME,
                },
            )

        raw_token = rotate_token(agent)
        self.log_change(request, agent, "Regenerated authentication token.")
        return self._token_page(request, agent, raw_token, title="New authentication token")

    def _page_context(self, request, agent: Agent, title: str) -> dict:
        return {
            **self.admin_site.each_context(request),
            "title": title,
            "opts": self.opts,
            "agent": agent,
        }

    def _token_page(self, request, agent: Agent, raw_token: str, *, title: str):
        response = TemplateResponse(
            request,
            TOKEN_PAGE_TEMPLATE,
            {**self._page_context(request, agent, title), "raw_token": raw_token},
        )
        # Never stored by the browser (back button, history) or any cache.
        add_never_cache_headers(response)
        return response
