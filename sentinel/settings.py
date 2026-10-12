"""Django settings for SSphere Sentinel.

Every deployment-specific value comes from the environment (see .env.example
and docs/server-deployment.md). Defaults are production-safe: DEBUG is off,
session and CSRF cookies are Secure, and proxy headers are never trusted by
Django itself (see "HTTPS and reverse proxies" below).
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value


def env_bool(name: str, default: bool = False) -> bool:
    """Parse a boolean; unrecognized values are an error, not ``False``.

    A typo such as ``DJANGO_SESSION_COOKIE_SECURE=ture`` must not silently
    weaken security.
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"Environment variable {name} must be true or false")


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(str(raw).strip())
    except ValueError as exc:
        raise RuntimeError(
            f"Environment variable {name} must be an integer"
        ) from exc
    return value


def env_list(name: str, default: str = "") -> list[str]:
    """Comma-separated list; blank items are ignored."""
    return [item.strip() for item in env(name, default).split(",") if item.strip()]


# Prefix of the example secrets in .env.example.
PLACEHOLDER_SECRET_PREFIX = "change-me"

DEBUG = env_bool("DJANGO_DEBUG", default=False)

SECRET_KEY = env("DJANGO_SECRET_KEY")
if not SECRET_KEY.strip():
    raise RuntimeError("Required environment variable DJANGO_SECRET_KEY is empty")
if not DEBUG and SECRET_KEY.startswith(PLACEHOLDER_SECRET_PREFIX):
    raise RuntimeError(
        "DJANGO_SECRET_KEY still has the .env.example placeholder value; "
        "generate a random secret before running with DJANGO_DEBUG=false"
    )
# Rotating the pepper invalidates every agent token, so a placeholder pepper
# is reported by `manage.py check --deploy` (sentinel.W001) instead of
# refusing to start an existing installation.
AGENT_TOKEN_PEPPER = env("AGENT_TOKEN_PEPPER")
if not AGENT_TOKEN_PEPPER.strip():
    raise RuntimeError("Required environment variable AGENT_TOKEN_PEPPER is empty")

# Seconds without a heartbeat before a server is considered offline.
# Default 90s pairs with the agent's default 30s heartbeat interval.
SENTINEL_OFFLINE_THRESHOLD = env_int("SENTINEL_OFFLINE_THRESHOLD", default=90)
if SENTINEL_OFFLINE_THRESHOLD <= 0:
    raise RuntimeError("SENTINEL_OFFLINE_THRESHOLD must be a positive integer")

# How long to retain historical NetworkMeasurement rows.
SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS = env_int(
    "SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS",
    default=30,
)
if SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS <= 0:
    raise RuntimeError(
        "SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS must be a positive integer"
    )

# Oldest measured_at accepted for delayed measurements (agent queue backlog).
# Default leaves a day of margin over the agent's default 7-day queue age;
# the effective window never exceeds the retention period.
SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS = env_int(
    "SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS",
    default=8,
)
if SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS <= 0:
    raise RuntimeError(
        "SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS must be a positive integer"
    )

# How long containers that disappeared from successful discoveries are kept.
SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS = env_int(
    "SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS",
    default=30,
)
if SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS <= 0:
    raise RuntimeError(
        "SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS must be a positive integer"
    )

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", default="localhost,127.0.0.1")
# Full origins (``https://sentinel.example.com``) allowed to submit admin forms
# when TLS is terminated in front of Django (reverse proxy, Cloudflare Tunnel).
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS")

# HTTPS and reverse proxies.
#
# Django does not read X-Forwarded-Proto itself (SECURE_PROXY_SSL_HEADER is
# deliberately unset). Gunicorn sets the request scheme from it only when the
# connection comes from an address in FORWARDED_ALLOW_IPS (default: loopback),
# so a client that reaches Gunicorn directly cannot claim HTTPS.
# See docs/security.md ("Trusted reverse proxy boundary").
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", default=False)
SECURE_HSTS_SECONDS = env_int("DJANGO_SECURE_HSTS_SECONDS", default=0)
if SECURE_HSTS_SECONDS < 0:
    raise RuntimeError("DJANGO_SECURE_HSTS_SECONDS must be zero or a positive integer")
SECURE_HSTS_INCLUDE_SUBDOMAINS = env_bool("DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS")
SECURE_HSTS_PRELOAD = env_bool("DJANGO_SECURE_HSTS_PRELOAD")
# Secure cookies by default outside DEBUG. Browsers send them over HTTPS only,
# so admin login over plain http:// needs both set to false (testing only).
SESSION_COOKIE_SECURE = env_bool("DJANGO_SESSION_COOKIE_SECURE", default=not DEBUG)
CSRF_COOKIE_SECURE = env_bool("DJANGO_CSRF_COOKIE_SECURE", default=not DEBUG)

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Project apps
    "apps.core",
    "apps.infrastructure",
    "apps.agents",
    "apps.network",
]

MIDDLEWARE = [
    # First: answers /health/ probes before ALLOWED_HOSTS validation and HTTPS
    # redirects, which container and load-balancer checks cannot satisfy.
    "apps.core.middleware.HealthCheckMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
if not DEBUG:
    # Serves the collected static files (admin CSS/JS) from Gunicorn, right
    # after SecurityMiddleware. With DEBUG on, runserver serves them instead.
    MIDDLEWARE.insert(
        MIDDLEWARE.index("django.middleware.security.SecurityMiddleware") + 1,
        "whitenoise.middleware.WhiteNoiseMiddleware",
    )

ROOT_URLCONF = "sentinel.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "sentinel.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": env("POSTGRES_DB"),
        "USER": env("POSTGRES_USER"),
        "PASSWORD": env("POSTGRES_PASSWORD"),
        "HOST": env("POSTGRES_HOST", default="localhost"),
        "PORT": env("POSTGRES_PORT", default="5432"),
        # Fail fast (readiness check, requests) instead of hanging on an
        # unreachable database host.
        "OPTIONS": {"connect_timeout": 10},
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    # Pre-compressed copies are created by collectstatic. Not the manifest
    # (hashed-name) variant: that requires collectstatic before any template
    # renders, including in tests, and only the admin uses static files.
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Logging: everything goes to stderr (captured by Docker or journald). Django
# only logs request paths, never headers, so agent tokens never reach the log.
# Server errors (HTTP 500) are logged with their traceback; Django's default
# configuration would drop them when DEBUG is off.
LOG_LEVEL = env("DJANGO_LOG_LEVEL", default="INFO").strip().upper()
if LOG_LEVEL not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
    raise RuntimeError(
        "DJANGO_LOG_LEVEL must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL"
    )
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "plain": {"format": "%(asctime)s %(levelname)s %(name)s: %(message)s"},
    },
    "filters": {
        "disallowed_host": {"()": "apps.core.log.DisallowedHostFilter"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "plain"},
    },
    "root": {"handlers": ["console"], "level": "WARNING"},
    "loggers": {
        "django": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
        "django.security.DisallowedHost": {
            "handlers": ["console"],
            "level": "WARNING",
            "filters": ["disallowed_host"],
            "propagate": False,
        },
        "apps": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
    },
}
