import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


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


SECRET_KEY = env("DJANGO_SECRET_KEY")
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

DEBUG = env_bool("DJANGO_DEBUG", default=False)
ALLOWED_HOSTS = [
    host.strip()
    for host in env("DJANGO_ALLOWED_HOSTS", default="localhost,127.0.0.1").split(",")
    if host.strip()
]

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
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

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

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
