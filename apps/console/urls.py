from django.urls import path, re_path

from apps.console import containers, history, servers, views
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
    # Unknown URLs under the prefix are JSON too (the UI never sees an HTML 404).
    re_path(r"^", not_found),
]
