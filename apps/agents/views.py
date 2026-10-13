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
from apps.network.reports import (
    NetworkValidationError,
    apply_network_report,
    validate_network_payload,
)
from apps.snmp.reports import (
    SnmpValidationError,
    apply_snmp_report,
    validate_snmp_payload,
)

INVALID_JSON = "invalid JSON body"


@csrf_exempt
@require_POST
def agent_heartbeat(request):
    """Accept an authenticated agent heartbeat with optional subsystems.

    Authentication uses ``Authorization: Bearer <token>``.

    Subsystems (telemetry, docker, network, snmp) are validated and applied
    independently. Invalid subsystem data does not block liveness or other
    valid subsystems. Network measurements are also validated individually:
    ``network`` is ``accepted``, ``partial`` or ``rejected`` and the response
    carries accepted/rejected counts.
    """
    result = authenticate_agent(request)
    if result.agent is None:
        return JsonResponse({"detail": result.error}, status=401)

    agent = result.agent
    payload, body_error = _parse_body(request)
    # Always refresh liveness after successful authentication.
    record_heartbeat(agent)
    if body_error is not None:
        if body_error == INVALID_JSON and "application/json" not in (request.content_type or ""):
            return JsonResponse({"status": "ok"})
        return JsonResponse({"status": "ok", "telemetry": "ignored", "detail": body_error})

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
            if apply_docker_report(agent.server, docker_report):
                response["docker"] = "accepted"
            else:
                response["docker"] = "rejected"
                response["docker_detail"] = "report is not newer than the inventory already stored"
        except DockerValidationError as exc:
            response["docker"] = "rejected"
            response["docker_detail"] = str(exc)

    if "network" in payload:
        try:
            network_report = validate_network_payload(payload["network"], agent=agent)
            ingest = apply_network_report(agent, network_report)
            response["network"] = ingest.status
            response["network_created"] = ingest.created
            response["network_duplicates"] = ingest.duplicates
            response["network_accepted"] = ingest.accepted
            response["network_rejected"] = ingest.rejected
            response["network_results"] = ingest.results()
            if ingest.rejections:
                response["network_rejections"] = [
                    rejection.as_dict() for rejection in ingest.rejections
                ]
                response["network_detail"] = (
                    f"{ingest.rejected} measurement(s) rejected; "
                    f"first: {ingest.rejections[0].reason}"
                )
        except NetworkValidationError as exc:
            response["network"] = "rejected"
            response["network_detail"] = str(exc)

    if "snmp" in payload:
        response.update(_snmp_response(agent, payload["snmp"]))

    return JsonResponse(response)


def _snmp_response(agent, raw_section) -> dict:
    """Validate and store the ``snmp`` section; the keys to add to the response.

    Same shape as the network acknowledgement, with a per-poll ``snmp_results``
    list so the agent can remove exactly the polls that are stored.
    """
    try:
        report = validate_snmp_payload(raw_section, agent=agent)
        result = apply_snmp_report(agent, report)
    except SnmpValidationError as exc:
        return {"snmp": "rejected", "snmp_detail": str(exc)}

    response = {
        "snmp": result.status,
        "snmp_created": result.created,
        "snmp_duplicates": result.duplicates,
        "snmp_accepted": result.accepted,
        "snmp_rejected": result.rejected,
        "snmp_results": result.results(),
    }
    if result.rejections:
        response["snmp_rejections"] = [rejection.as_dict() for rejection in result.rejections]
        response["snmp_detail"] = (
            f"{result.rejected} poll(s) rejected; first: {result.rejections[0].reason}"
        )
    return response


def _parse_body(request) -> tuple[dict, str | None]:
    """Return ``(payload, error)``; an empty body is an empty payload."""
    raw_body = request.body.strip() if request.body else b""
    if not raw_body:
        return {}, None
    try:
        loaded = json.loads(raw_body)
    except ValueError:
        # JSONDecodeError, invalid UTF-8, or an integer literal over Python's
        # digit limit: all are malformed bodies, never a server error.
        return {}, INVALID_JSON
    if loaded is None:
        return {}, None
    if not isinstance(loaded, dict):
        return {}, "JSON body must be an object"
    return loaded, None
