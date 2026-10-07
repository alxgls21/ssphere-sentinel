"""WSGI config for SSphere Sentinel."""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "sentinel.settings")

application = get_wsgi_application()
