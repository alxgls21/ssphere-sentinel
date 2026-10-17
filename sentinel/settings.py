"""Django settings for SSphere Sentinel.

Every deployment-specific value comes from the environment (see .env.example
and docs/server-deployment.md). Defaults are production-safe: DEBUG is off,
session and CSRF cookies are Secure, and proxy headers are never trusted by
Django itself (see "HTTPS and reverse proxies" below).
"""

import os
import re
from pathlib import Path

from sentinel import database as sentinel_database

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


# The sender, in the two plain forms "sentinel@example.com" and "Sentinel <sentinel@example.com>":
# an ASCII local part (dot-atom), a domain name (international too), and a name without the
# characters that make it more than text. Nothing else (quoted local parts, comments, encoded
# words, domain literals): Django's SMTP backend sends those differently, or not at all, from
# one release to the next.
_LOCAL_PART = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
_SENDER = re.compile(
    rf"(?P<name>[^<>()\[\]\\\",;:@]+?)\s*<(?P<bracketed>{_LOCAL_PART}@[^\s<>@]+)>|(?P<plain>{_LOCAL_PART}@[^\s<>@]+)"
)
_DOMAIN_LABEL = re.compile(r"[^\W_](?:(?:[^\W_]|-)*[^\W_])?")  # letters, digits, inner hyphens


def one_mailbox(value: str) -> bool:
    """Whether ``value`` is one sender address in a plain form (see ``_SENDER``)."""
    match = _SENDER.fullmatch(value)
    if match is None or not value.isprintable() or "=?" in value:
        return False
    domain = (match["bracketed"] or match["plain"]).rpartition("@")[2]
    if not all(_DOMAIN_LABEL.fullmatch(label) for label in domain.split(".")):
        return False
    try:
        domain.encode("idna")  # a label too long, or a character IDNA cannot encode
    except UnicodeError:
        return False
    return True


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

# How long SNMP polls and interface samples are kept. Cleanup via:
#   python manage.py purge_snmp_data
SENTINEL_SNMP_RETENTION_DAYS = env_int("SENTINEL_SNMP_RETENTION_DAYS", default=30)
if SENTINEL_SNMP_RETENTION_DAYS <= 0:
    raise RuntimeError("SENTINEL_SNMP_RETENTION_DAYS must be a positive integer")

# Oldest measured_at accepted for delayed SNMP polls (agent queue backlog);
# the effective window never exceeds the retention period.
SENTINEL_SNMP_MAX_AGE_DAYS = env_int("SENTINEL_SNMP_MAX_AGE_DAYS", default=8)
if SENTINEL_SNMP_MAX_AGE_DAYS <= 0:
    raise RuntimeError("SENTINEL_SNMP_MAX_AGE_DAYS must be a positive integer")

# How long containers that disappeared from successful discoveries are kept.
SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS = env_int(
    "SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS",
    default=30,
)
if SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS <= 0:
    raise RuntimeError(
        "SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS must be a positive integer"
    )

# Server telemetry history (the CPU, memory and disk charts). At most one
# sample per server per SENTINEL_TELEMETRY_SAMPLE_SECONDS is stored (the first
# one received for each slot), however often the agent reports; samples older
# than the retention period are removed by
#   python manage.py purge_telemetry_samples
# The retention must cover the longest chart range (24 hours) with margin.
SENTINEL_TELEMETRY_RETENTION_DAYS = env_int("SENTINEL_TELEMETRY_RETENTION_DAYS", default=7)
if not 2 <= SENTINEL_TELEMETRY_RETENTION_DAYS <= 365:
    raise RuntimeError("SENTINEL_TELEMETRY_RETENTION_DAYS must be between 2 and 365")
# A divisor of 60, or 300: only then does the sample grid line up with the
# chart buckets (1, 5 and 15 minutes), so every bucket holds whole samples.
SENTINEL_TELEMETRY_SAMPLE_SECONDS = env_int("SENTINEL_TELEMETRY_SAMPLE_SECONDS", default=60)
if not (
    5 <= SENTINEL_TELEMETRY_SAMPLE_SECONDS <= 60 and 60 % SENTINEL_TELEMETRY_SAMPLE_SECONDS == 0
) and SENTINEL_TELEMETRY_SAMPLE_SECONDS != 300:
    raise RuntimeError(
        "SENTINEL_TELEMETRY_SAMPLE_SECONDS must be a divisor of 60 from 5 to 60 (5, 6, 10, 12, 15, 20, 30, 60) or 300"
    )

# Console (the read API behind the web UI, /api/v1/console/). Its sessions and
# sign-in throttle; see docs/security.md ("Console authentication").
SENTINEL_CONSOLE_SESSION_SECONDS = env_int("SENTINEL_CONSOLE_SESSION_SECONDS", default=12 * 3600)
if not 300 <= SENTINEL_CONSOLE_SESSION_SECONDS <= 30 * 86400:
    raise RuntimeError("SENTINEL_CONSOLE_SESSION_SECONDS must be between 300 and 2592000")
SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS = env_int("SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS", default=5)
if not 1 <= SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS <= 100:
    raise RuntimeError("SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS must be between 1 and 100")
SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS = env_int("SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS", default=900)
if not 60 <= SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS <= 86400:
    raise RuntimeError("SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS must be between 60 and 86400")

# Health thresholds the console reports (display defaults, not alert rules).
SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT = env_int("SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT", default=80)
SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT = env_int("SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT", default=95)
if not (
    1 <= SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT < SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT <= 100
):
    raise RuntimeError(
        "SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT must be at least 1 and below "
        "SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT, which must be at most 100"
    )
SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT = env_int("SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT", default=2)
if not 1 <= SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT <= 100:
    raise RuntimeError("SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT must be between 1 and 100")
SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS = env_int("SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS", default=150)
if not 1 <= SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS <= 60_000:
    raise RuntimeError("SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS must be between 1 and 60000")
SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES = env_int("SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES", default=3)
if not 1 <= SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES <= 1000:
    raise RuntimeError("SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES must be between 1 and 1000")

# Alerts. An incident is kept, with its history, for INCIDENT_RETENTION_DAYS
# after it ended; open incidents are never removed. The record of each email is
# kept for NOTIFICATION_RETENTION_DAYS (or until its incident goes). Cleanup via:
#   python manage.py purge_incidents
#   python manage.py purge_notifications
SENTINEL_INCIDENT_RETENTION_DAYS = env_int("SENTINEL_INCIDENT_RETENTION_DAYS", default=365)
if not 7 <= SENTINEL_INCIDENT_RETENTION_DAYS <= 3650:
    raise RuntimeError("SENTINEL_INCIDENT_RETENTION_DAYS must be between 7 and 3650")
SENTINEL_NOTIFICATION_RETENTION_DAYS = env_int("SENTINEL_NOTIFICATION_RETENTION_DAYS", default=90)
if not 1 <= SENTINEL_NOTIFICATION_RETENTION_DAYS <= 3650:
    raise RuntimeError("SENTINEL_NOTIFICATION_RETENTION_DAYS must be between 1 and 3650")

# Email notifications: optional, and off unless SENTINEL_SMTP_HOST is set. The
# credentials come from the environment only, never from the database, and in
# Docker Compose reach the notifier service only. Only console users who have a
# subscription (in the admin) receive anything.
SENTINEL_SMTP_HOST = env("SENTINEL_SMTP_HOST", default="").strip()
SENTINEL_SMTP_PORT = env_int("SENTINEL_SMTP_PORT", default=587)
if not 1 <= SENTINEL_SMTP_PORT <= 65535:
    raise RuntimeError("SENTINEL_SMTP_PORT must be between 1 and 65535")
# starttls (submission, usually port 587), tls (implicit TLS, usually 465), or
# none (a relay on a trusted network; then no credentials may be set).
SENTINEL_SMTP_SECURITY = env("SENTINEL_SMTP_SECURITY", default="starttls").strip().lower()
if SENTINEL_SMTP_SECURITY not in {"starttls", "tls", "none"}:
    raise RuntimeError("SENTINEL_SMTP_SECURITY must be one of starttls, tls, none")
SENTINEL_SMTP_USER = env("SENTINEL_SMTP_USER", default="").strip()
SENTINEL_SMTP_PASSWORD = env("SENTINEL_SMTP_PASSWORD", default="")
# SMTP authentication (smtplib) sends ASCII only.
if not (SENTINEL_SMTP_USER.isascii() and SENTINEL_SMTP_PASSWORD.isascii()):
    raise RuntimeError("SENTINEL_SMTP_USER and SENTINEL_SMTP_PASSWORD must be ASCII: SMTP authentication cannot send other characters")
if SENTINEL_SMTP_PASSWORD and not SENTINEL_SMTP_USER:
    raise RuntimeError("SENTINEL_SMTP_PASSWORD is set without SENTINEL_SMTP_USER")
if SENTINEL_SMTP_SECURITY == "none" and (SENTINEL_SMTP_USER or SENTINEL_SMTP_PASSWORD):
    raise RuntimeError("SENTINEL_SMTP_SECURITY=none would send the SMTP credentials unencrypted: use starttls or tls")
# Seconds for each SMTP connection and command: a slow server never holds a cycle long.
SENTINEL_SMTP_TIMEOUT = env_int("SENTINEL_SMTP_TIMEOUT", default=10)
if not 1 <= SENTINEL_SMTP_TIMEOUT <= 60:
    raise RuntimeError("SENTINEL_SMTP_TIMEOUT must be between 1 and 60")
SENTINEL_EMAIL_FROM = env("SENTINEL_EMAIL_FROM", default="").strip()
if SENTINEL_SMTP_HOST and not one_mailbox(SENTINEL_EMAIL_FROM):
    raise RuntimeError(
        "SENTINEL_EMAIL_FROM must be one email address, sentinel@example.com or Sentinel <sentinel@example.com>, "
        "when SENTINEL_SMTP_HOST is set"
    )
# The console's address (https://sentinel.example.com), for links in the emails; none without it.
SENTINEL_CONSOLE_URL = env("SENTINEL_CONSOLE_URL", default="").strip().rstrip("/")
if SENTINEL_CONSOLE_URL and not SENTINEL_CONSOLE_URL.startswith(("https://", "http://")):
    raise RuntimeError("SENTINEL_CONSOLE_URL must start with https:// or http://")
# An email not sent within this many hours (the notifier was stopped, the SMTP
# server unreachable) is given up rather than sent late.
SENTINEL_NOTIFICATION_MAX_AGE_HOURS = env_int("SENTINEL_NOTIFICATION_MAX_AGE_HOURS", default=24)
if not 1 <= SENTINEL_NOTIFICATION_MAX_AGE_HOURS <= 168:
    raise RuntimeError("SENTINEL_NOTIFICATION_MAX_AGE_HOURS must be between 1 and 168")
# The one mailer, Django's SMTP backend with the settings above; only the notifier
# sends (apps.alerts.notifications). Django 6.1 reads MAILERS, Django 5.2 takes the
# same options through get_connection(). Certificates are verified.
MAILERS = {
    "default": {
        "BACKEND": "django.core.mail.backends.smtp.EmailBackend",
        "OPTIONS": {
            "host": SENTINEL_SMTP_HOST or "localhost",
            "port": SENTINEL_SMTP_PORT,
            "username": SENTINEL_SMTP_USER,
            "password": SENTINEL_SMTP_PASSWORD,
            "use_tls": SENTINEL_SMTP_SECURITY == "starttls",
            "use_ssl": SENTINEL_SMTP_SECURITY == "tls",
            "timeout": SENTINEL_SMTP_TIMEOUT,
        },
    }
}

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
    # Required for BrinIndex (enforced by a system check since Django 6.1).
    "django.contrib.postgres",
    # Project apps
    "apps.core",
    "apps.infrastructure",
    "apps.agents",
    "apps.network",
    "apps.inventory",
    "apps.snmp",
    "apps.console",
    "apps.alerts",
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

# CSRF rejections under /api/v1/console/ are JSON; everything else keeps Django's page.
CSRF_FAILURE_VIEW = "apps.console.http.csrf_failure"

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

# The login (user, password, assumed role) depends on SENTINEL_DB_ROLES and
# SENTINEL_DB_ACCESS; see sentinel/database.py. The engine is Django's, but
# refuses a superuser login in a database provisioned for separate logins.
database_name = env("POSTGRES_DB")
database_login = sentinel_database.login(os.environ)
DATABASES = {
    "default": {
        "ENGINE": "sentinel.postgresql",
        "NAME": database_name,
        "USER": database_login.user,
        "PASSWORD": database_login.password,
        "HOST": env("POSTGRES_HOST", default="localhost"),
        "PORT": env("POSTGRES_PORT", default="5432"),
        # Fail fast (readiness check, requests) instead of hanging on an
        # unreachable database host.
        "OPTIONS": {"connect_timeout": 10, **database_login.options},
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
