"""Health endpoints for container healthchecks and load balancers.

Responses never include configuration, versions, hostnames or error details;
database failures are logged server-side only.
"""

import logging

from django.db import DatabaseError, connection
from django.http import JsonResponse
from django.views.decorators.http import require_safe

logger = logging.getLogger(__name__)


def _no_store(response: JsonResponse) -> JsonResponse:
    response["Cache-Control"] = "no-store"
    return response


@require_safe
def health(request):
    """Liveness: the application process answers (no database access)."""
    return _no_store(JsonResponse({"status": "ok"}))


@require_safe
def readiness(request):
    """Readiness: the application can reach its PostgreSQL database."""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseError as exc:
        logger.warning("Readiness check failed: database unavailable: %s", exc)
        return _no_store(
            JsonResponse({"status": "unavailable", "database": "unavailable"}, status=503)
        )
    return _no_store(JsonResponse({"status": "ok", "database": "ok"}))
