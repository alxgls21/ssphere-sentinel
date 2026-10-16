#!/usr/bin/env bash
# Create throwaway .env and .env.tunnel files for CI from the shipped example.
# Every secret is random per run, masked in the log of a GitHub Actions job;
# nothing is stored in the repository.
#
#   ci-env.sh        a new installation: PostgreSQL 18 (.env.example)
#   ci-env.sh 18     the same
#   ci-env.sh 16     an existing installation, which stays on PostgreSQL 16: the
#                    .env of the releases before the setting existed
#                    (tests/deployment/legacy.env.example), without it
set -euo pipefail

major=${1:-18}
case "$major" in
    18) example=.env.example ;;
    16) example=tests/deployment/legacy.env.example ;;
    *) echo "usage: ci-env.sh [16|18]" >&2; exit 2 ;;
esac

secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
mask() { if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::add-mask::$1"; fi; }

django_key=$(secret)
pepper=$(secret)
bootstrap=$(secret)
mask "$django_key"
mask "$pepper"
mask "$bootstrap"

cp "$example" .env
sed -i \
    -e "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=$django_key|" \
    -e "s|^AGENT_TOKEN_PEPPER=.*|AGENT_TOKEN_PEPPER=$pepper|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$bootstrap|" \
    .env
if [ "$major" = 18 ]; then
    # The first start of a new PostgreSQL 18 installation must be authorized.
    sed -i -e 's|^# SENTINEL_POSTGRES_INITIALIZE=true|SENTINEL_POSTGRES_INITIALIZE=true|' .env
    grep -qx 'SENTINEL_POSTGRES_INITIALIZE=true' .env || { echo "initialization is not authorized in .env" >&2; exit 1; }
    grep -qx 'SENTINEL_POSTGRES=18' .env || { echo "PostgreSQL 18 is not selected in .env" >&2; exit 1; }
elif grep -q '^SENTINEL_POSTGRES=' .env; then
    echo "an installation on PostgreSQL 16 must not select a version in .env" >&2
    exit 1
fi
# Nothing the CI starts is reachable from outside the host it runs on.
printf 'SENTINEL_HTTP_BIND=127.0.0.1\n' >> .env
if grep -q '=change-me' .env; then
    echo "placeholder secret left in .env" >&2
    exit 1
fi
# Only used to validate compose.tunnel.yml; no tunnel is started in CI.
echo "TUNNEL_TOKEN=ci-placeholder-not-a-real-token" > .env.tunnel
