# syntax=docker/dockerfile:1

# SSphere Sentinel server image (Django + Gunicorn). The host agent is not
# included: it is installed separately on monitored hosts (agent/).
#
# If you change the Python version, regenerate requirements/server.txt with
#   python scripts/update_server_requirements.py --python-version X.Y
ARG PYTHON_IMAGE=python:3.13-slim-trixie

# --- Dependencies: exact versions, verified by hash, wheels only -------------
FROM ${PYTHON_IMAGE} AS deps

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements/server.txt /tmp/requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --require-hashes --only-binary=:all: \
        -r /tmp/requirements.txt

# --- Runtime -----------------------------------------------------------------
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}"

# Unprivileged runtime user with a fixed UID/GID.
RUN groupadd --system --gid 10001 sentinel \
    && useradd --system --uid 10001 --gid sentinel \
        --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin sentinel

WORKDIR /app

COPY --from=deps /opt/venv /opt/venv
COPY manage.py gunicorn.conf.py entrypoint.sh ./
COPY sentinel ./sentinel
COPY apps ./apps

# Collect the admin's static files (served by WhiteNoise) and precompile the
# application. Settings need values for their required variables at import
# time; these placeholders exist only for this build step and are not secrets.
# Everything stays owned by root and read-only for the runtime user.
RUN DJANGO_SECRET_KEY=collectstatic-build-step-only \
    AGENT_TOKEN_PEPPER=collectstatic-build-step-only \
    POSTGRES_DB=unused POSTGRES_USER=unused POSTGRES_PASSWORD=unused \
    python manage.py collectstatic --noinput --verbosity 0 \
    && python -m compileall -q sentinel apps \
    && chmod 0755 entrypoint.sh

USER sentinel:sentinel

EXPOSE 8000

# Readiness: Gunicorn answers and the database is reachable. Health checks
# bypass ALLOWED_HOSTS and HTTPS redirects (apps.core.middleware).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/ready/', timeout=4).status == 200 else 1)"]

ENTRYPOINT ["./entrypoint.sh"]
# Gunicorn is PID 1's exec target: SIGTERM triggers a graceful shutdown.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "sentinel.wsgi:application"]
