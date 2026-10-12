"""Admin list filters shared by apps that reference an Agent."""

from django.contrib import admin

from apps.agents.models import Agent


class AgentListFilter(admin.RelatedFieldListFilter):
    """Agent filter whose choice labels (``Agent.__str__``) need no per-agent query."""

    def field_choices(self, field, request, model_admin):
        ordering = self.field_admin_ordering(field, request, model_admin) or ()
        agents = Agent.objects.select_related("server").order_by(*ordering)
        return [(agent.pk, str(agent)) for agent in agents]
