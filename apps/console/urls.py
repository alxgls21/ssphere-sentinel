from django.urls import path, re_path

from apps.console import containers, devices, history, incidents, servers, targets, topology, views
from apps.console.http import not_found

urlpatterns = [
    path("session/", views.session, name="console-session"),
    path("auth/login/", views.sign_in, name="console-login"),
    path("auth/logout/", views.sign_out, name="console-logout"),
    path("scope/", views.scope, name="console-scope"),
    path("servers/", servers.server_list, name="console-servers"),
    path("servers/<uuid:server_id>/", servers.server_detail, name="console-server"),
    path("servers/<uuid:server_id>/series/", history.server_series, name="console-server-series"),
    path("containers/", containers.container_list, name="console-containers"),
    path("targets/", targets.target_list, name="console-targets"),
    path("targets/<uuid:target_id>/", targets.target_detail, name="console-target"),
    path("targets/<uuid:target_id>/series/", targets.target_series, name="console-target-series"),
    path("devices/", devices.device_list, name="console-devices"),
    path("devices/<uuid:device_id>/", devices.device_detail, name="console-device"),
    path("devices/<uuid:device_id>/series/", devices.device_series, name="console-device-series"),
    path(
        "devices/<uuid:device_id>/interfaces/<int:if_index>/series/",
        devices.interface_series,
        name="console-interface-series",
    ),
    path("topology/", topology.topology, name="console-topology"),
    path("incidents/", incidents.incident_list, name="console-incidents"),
    path("incidents/<uuid:incident_id>/", incidents.incident_detail, name="console-incident"),
    path(
        "incidents/<uuid:incident_id>/acknowledge/",
        incidents.incident_acknowledge,
        name="console-incident-acknowledge",
    ),
    path("alerts/engine-status/", incidents.engine_status, name="console-alert-engine-status"),
    # Unknown URLs under the prefix are JSON too (the UI never sees an HTML 404).
    re_path(r"^", not_found),
]
