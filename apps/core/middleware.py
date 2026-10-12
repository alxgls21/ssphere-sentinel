from apps.core.views import health, readiness

HEALTH_VIEWS = {
    "/health/": health,
    "/health/ready/": readiness,
}


class HealthCheckMiddleware:
    """Answer health checks before host validation and HTTPS redirects.

    Container and load-balancer probes connect by IP address over plain HTTP,
    so ALLOWED_HOSTS would reject them and SECURE_SSL_REDIRECT would redirect
    them. Must be the first middleware. The responses contain nothing derived
    from the request, so skipping host validation for them is safe.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        view = HEALTH_VIEWS.get(request.path_info)
        if view is not None:
            return view(request)
        return self.get_response(request)
