#!/usr/bin/env bash
# Create throwaway .env and .env.tunnel files for CI from the shipped example.
# Every secret is random per run; nothing is stored in the repository.
set -euo pipefail

secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }

cp .env.example .env
sed -i \
    -e "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=$(secret)|" \
    -e "s|^AGENT_TOKEN_PEPPER=.*|AGENT_TOKEN_PEPPER=$(secret)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
    .env
# The first start of a new PostgreSQL 18 installation must be authorized.
sed -i -e 's|^# SENTINEL_POSTGRES_INITIALIZE=true|SENTINEL_POSTGRES_INITIALIZE=true|' .env
grep -qx 'SENTINEL_POSTGRES_INITIALIZE=true' .env || { echo "initialization is not authorized in .env" >&2; exit 1; }
if grep -q '=change-me' .env; then
    echo "placeholder secret left in .env" >&2
    exit 1
fi
# Only used to validate compose.tunnel.yml; no tunnel is started in CI.
echo "TUNNEL_TOKEN=ci-placeholder-not-a-real-token" > .env.tunnel
