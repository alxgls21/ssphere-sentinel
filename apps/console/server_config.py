"""Changing and deleting monitored hosts from the console: ``PATCH`` and ``DELETE /servers/<id>/``.

Who: what adding a server needs (``apps.console.enrollment``), with the admin's permission for
the action: ``infrastructure.change_server`` to change, ``infrastructure.delete_server`` to
delete; otherwise 403. A hidden or unknown server is a 404 (``GET /servers/<id>/`` is
``apps.console.servers``).

Change, ``PATCH /servers/<id>/`` with any of the fields of ``POST /servers/`` (``name``,
``hostname``, ``description``, ``operatingSystem``, ``ipAddress``, ``siteId``): only the fields
sent change; a blank hostname takes the name, as on creation; the same checks, 409
``server_exists`` and 400 ``validation_error`` answers. 200 with the server's detail. Nothing to
change answers the detail as it is. Placing a server on another site changes who sees it.

Delete, ``DELETE /servers/<id>/`` with no body: the server goes, and with it its agent (whose
token stops working at once: the host's agent gets 401 until it is removed), the latest
telemetry and the telemetry history, and the Docker containers and host state last reported.
The network measurements its agent reported are kept, without their agent; the network targets
and devices assigned to its agent lose it (nothing measures them until another agent is
assigned); incidents of the server end at the alert engine's next cycle (``entity_removed``).
200 with what was done::

    {"generatedAt", "deleted": {"id", "name", "agent": bool, "telemetrySamples": int,
     "containers": int, "measurementsKept": int, "targetsUnassigned": int, "devicesUnassigned": int}}

Every write is logged (``apps.console``) and recorded in the audit trail (``apps.console.audit``).
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.utils import timezone

from apps.console import audit, servers
from apps.console.enrollment import (
    ERROR_FIELDS,
    MAX_SERVER_BODY_BYTES,
    NAME_TAKEN,
    name_taken,
    name_taken_meanwhile,
    parse_server,
    server_values,
)
from apps.console.fields import model_errors
from apps.console.http import ApiError, console_api, json_object, validation_error
from apps.console.params import QueryParams
from apps.console.permissions import may_change_servers, may_delete_servers, require
from apps.console.serializers import iso
from apps.infrastructure.models import DockerContainer, Server, ServerTelemetrySample
from apps.inventory.models import Device
from apps.network.models import NetworkMeasurement, NetworkTarget

logger = logging.getLogger("apps.console")

NOT_PERMITTED_CHANGE = "This account may not change monitored hosts."
NOT_PERMITTED_DELETE = "This account may not delete monitored hosts."


@console_api(methods=("GET", "PATCH", "DELETE"))
def server_item(request, server_id: UUID):
    if request.method == "PATCH":
        return change_server(request, server_id)
    if request.method == "DELETE":
        return delete_server(request, server_id)
    return servers.server_detail(request, server_id)


def change_server(request, server_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_change_servers(user, request.visibility), NOT_PERMITTED_CHANGE)
    QueryParams(request, ())
    values = parse_server(json_object(request, max_bytes=MAX_SERVER_BODY_BYTES), partial=True)
    try:
        with transaction.atomic():
            # The row is held until the end: no other change slips in between the check and the save.
            server = request.visibility.get(Server.objects.select_for_update(no_key=True), server_id)
            before = server_values(server)
            for field, value in values.items():
                setattr(server, field, value)
            if "hostname" in values and not values["hostname"]:
                server.hostname = server.name  # a blank hostname takes the name, as on creation
            if server_values(server) != before:
                server.full_clean()  # the model's own checks, and its spelling of an address
                server.save()
                audit.record(
                    user,
                    action="server_changed",
                    target_type=audit.SERVER,
                    target_id=server.pk,
                    target_name=server.name,
                    changed=audit.changes(before, server_values(server)),
                )
                logger.info("Server changed (server=%s, site=%s, user_id=%s)", server.pk, server.site_id, user.pk)
    except ValidationError as error:
        if name_taken(error):
            raise ApiError(409, "server_exists", NAME_TAKEN) from None
        raise validation_error(model_errors(error, ERROR_FIELDS)) from None
    except IntegrityError as error:
        if not name_taken_meanwhile(error):
            raise
        raise ApiError(409, "server_exists", NAME_TAKEN) from None
    return JsonResponse(servers.detail_payload(request.visibility, server.pk, now))


def delete_server(request, server_id: UUID):
    now = timezone.now()
    user = request.user
    require(may_delete_servers(user, request.visibility), NOT_PERMITTED_DELETE)
    QueryParams(request, ())
    data = json_object(request, max_bytes=1024, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: a deletion has no options."] for name in sorted(data)})
    with transaction.atomic():
        server = request.visibility.get(Server.objects.select_for_update(), server_id)
        # What goes with it, and what only loses its agent, counted before the rows are gone.
        done = {
            "id": str(server.pk),
            "name": server.name,
            "agent": Server.objects.filter(pk=server.pk, agent__isnull=False).exists(),
            "telemetrySamples": ServerTelemetrySample.objects.filter(server=server).count(),
            "containers": DockerContainer.objects.filter(server=server).count(),
            "measurementsKept": NetworkMeasurement.objects.filter(agent__server=server).count(),
            "targetsUnassigned": NetworkTarget.objects.filter(assigned_agent__server=server).count(),
            "devicesUnassigned": Device.objects.filter(assigned_agent__server=server).count(),
        }
        audit.record(
            user,
            action="server_deleted",
            target_type=audit.SERVER,
            target_id=server.pk,
            target_name=server.name,
            changed={**audit.changes(server_values(server), {}), "agentDeleted": {"before": None, "after": done["agent"]}},
        )
        server.delete()
    logger.info(
        "Server deleted (server=%s, agent=%s, samples=%s, containers=%s, user_id=%s)",
        done["id"],
        done["agent"],
        done["telemetrySamples"],
        done["containers"],
        user.pk,
    )
    return JsonResponse({"generatedAt": iso(now), "deleted": done})
