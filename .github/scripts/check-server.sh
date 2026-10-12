#!/usr/bin/env bash
# Checks against the running Compose stack (docker compose up --wait).
set -euo pipefail

base=http://127.0.0.1:8000
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "liveness:  $(curl --fail --silent --show-error "$base/health/")"
echo "readiness: $(curl --fail --silent --show-error "$base/health/ready/")"

# Admin static files are collected into the image and served by WhiteNoise.
curl --fail --silent --show-error --output /dev/null "$base/static/admin/css/base.css" \
    || fail "admin static files are not served"

# The application runs as the unprivileged image user on a read-only root fs.
uid=$(docker compose exec -T web id -u)
[ "$uid" = "10001" ] || fail "web runs as uid $uid"
if docker compose exec -T web sh -c 'touch /app/write-probe' 2>/dev/null; then
    fail "root filesystem is writable"
fi

# PostgreSQL must not be reachable from the host.
if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then
    fail "PostgreSQL is published on the host"
fi

# Django's deployment checks pass (HSTS/SSL-redirect warnings are expected:
# they depend on how TLS is terminated in front of the server).
docker compose exec -T web python manage.py check --deploy
echo "server checks passed"
