from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from apps.agents.authentication import authenticate_agent
from apps.agents.services import record_heartbeat


@csrf_exempt
@require_POST
def agent_heartbeat(request):
    """Accept an authenticated agent heartbeat.

    Authentication uses ``Authorization: Bearer <token>``. The request body is
    ignored for now so future optional payloads can be added without breaking
    clients. Tokens must never be sent in the URL or query string.
    """
    result = authenticate_agent(request)
    if result.agent is None:
        return JsonResponse({"detail": result.error}, status=401)

    record_heartbeat(result.agent)
    return JsonResponse({"status": "ok"})
