import json

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from apps.agents.authentication import authenticate_agent
from apps.agents.services import record_heartbeat
from apps.infrastructure.telemetry import (
    TelemetryValidationError,
    upsert_server_telemetry,
    validate_telemetry_payload,
)


@csrf_exempt
@require_POST
def agent_heartbeat(request):
    """Accept an authenticated agent heartbeat, optionally with telemetry.

    Authentication uses ``Authorization: Bearer <token>``.

    Protocol:
    - Empty body / ``{}`` / omitted ``telemetry`` → liveness only.
    - Valid ``telemetry`` (version 1) → upsert latest ``ServerTelemetry``.
    - Invalid ``telemetry`` → liveness is still recorded; telemetry is rejected
      and the previous snapshot is left unchanged.
    """
    result = authenticate_agent(request)
    if result.agent is None:
        return JsonResponse({"detail": result.error}, status=401)

    agent = result.agent
    payload: dict = {}
    raw_body = request.body.strip() if request.body else b""
    if raw_body:
        try:
            loaded = json.loads(raw_body)
        except json.JSONDecodeError:
            # Empty form posts and non-JSON clients still get liveness updates.
            record_heartbeat(agent)
            if "application/json" in (request.content_type or ""):
                return JsonResponse(
                    {
                        "status": "ok",
                        "telemetry": "ignored",
                        "detail": "invalid JSON body",
                    }
                )
            return JsonResponse({"status": "ok"})
        if loaded is None:
            loaded = {}
        if not isinstance(loaded, dict):
            record_heartbeat(agent)
            return JsonResponse(
                {
                    "status": "ok",
                    "telemetry": "ignored",
                    "detail": "JSON body must be an object",
                }
            )
        payload = loaded

    # Always refresh liveness after successful authentication.
    record_heartbeat(agent)

    if "telemetry" not in payload:
        return JsonResponse({"status": "ok"})

    try:
        validated = validate_telemetry_payload(payload["telemetry"])
        upsert_server_telemetry(agent.server, validated)
    except TelemetryValidationError as exc:
        return JsonResponse(
            {
                "status": "ok",
                "telemetry": "rejected",
                "detail": str(exc),
            }
        )

    return JsonResponse({"status": "ok", "telemetry": "accepted"})
