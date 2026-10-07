import json

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from apps.agents.authentication import authenticate_agent
from apps.agents.services import record_heartbeat
from apps.infrastructure.docker_reports import (
    DockerValidationError,
    apply_docker_report,
    validate_docker_payload,
)
from apps.infrastructure.telemetry import (
    TelemetryValidationError,
    upsert_server_telemetry,
    validate_telemetry_payload,
)


@csrf_exempt
@require_POST
def agent_heartbeat(request):
    """Accept an authenticated agent heartbeat with optional subsystems.

    Authentication uses ``Authorization: Bearer <token>``.

    Subsystems (telemetry, docker) are validated and applied independently.
    Invalid subsystem data does not block liveness or other valid subsystems.
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

    response: dict = {"status": "ok"}

    if "telemetry" in payload:
        try:
            validated = validate_telemetry_payload(payload["telemetry"])
            upsert_server_telemetry(agent.server, validated)
            response["telemetry"] = "accepted"
        except TelemetryValidationError as exc:
            response["telemetry"] = "rejected"
            response["detail"] = str(exc)

    if "docker" in payload:
        try:
            docker_report = validate_docker_payload(payload["docker"])
            apply_docker_report(agent.server, docker_report)
            response["docker"] = "accepted"
        except DockerValidationError as exc:
            response["docker"] = "rejected"
            response["docker_detail"] = str(exc)

    return JsonResponse(response)
