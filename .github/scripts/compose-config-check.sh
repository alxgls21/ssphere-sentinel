#!/usr/bin/env bash
# Resolves the Compose configuration, without starting anything, with the .env
# of an existing installation (tests/deployment/legacy.env.example), of a new
# installation (.env.example) and of separate database roles, and checks that
#   - each one resolves (Compose before 2.24 refuses an env_file listed twice);
#   - an existing installation resolves the database service it always ran;
#   - only the migrate service receives the migration login's password.
# Writes and removes .env and .env.migrate in the working tree: CI only.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ ! -e .env ] && [ ! -e .env.migrate ] || fail ".env or .env.migrate exists: run this on a fresh checkout"
work=$(mktemp -d)
trap 'rm -rf "$work"; rm -f .env .env.migrate' EXIT

secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
env_from() {  # env_from <example>: the example with random secrets, as .env
    sed -e "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=$(secret)|" \
        -e "s|^AGENT_TOKEN_PEPPER=.*|AGENT_TOKEN_PEPPER=$(secret)|" \
        -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
        "$1" > .env
}

# check <migration password or empty>: the resolved services and who gets the secret.
check() {
    docker compose config --quiet
    docker compose config --format json > "$work/config.json"
    python3 - "$work/config.json" "$1" <<'PY'
import json
import sys

services = json.load(open(sys.argv[1]))["services"]
secret = sys.argv[2]
assert set(services) == {"db", "migrate", "web"}, sorted(services)
web, migrate = services["web"]["environment"], services["migrate"]["environment"]
assert web.get("DJANGO_SECRET_KEY") and migrate.get("DJANGO_SECRET_KEY"), "the env files were not resolved"
assert (web["SENTINEL_DB_ACCESS"], migrate["SENTINEL_DB_ACCESS"]) == ("runtime", "migrate")
assert not web.get("SENTINEL_DB_MIGRATE_PASSWORD"), "web receives the migration password"
assert (migrate.get("SENTINEL_DB_MIGRATE_PASSWORD") or "") == secret, "migrate lacks its password"
assert services["web"]["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
print("resolved:", ", ".join(sorted(services)))
PY
}

docker compose version

step "An existing installation: its unchanged .env"
env_from tests/deployment/legacy.env.example
check ""
[ "$(docker compose config --hash db)" = \
    "$(docker compose --file tests/deployment/postgres16-reference.yml --project-directory . config --hash db)" ] \
    || fail "the PostgreSQL 16 service differs from the one earlier releases ran"

step "A new installation: .env.example"
env_from .env.example
check ""

step "Separate database roles: the migration password in its own file"
env_from tests/deployment/legacy.env.example
migration=$(secret)
printf 'SENTINEL_DB_ROLES=separate\nSENTINEL_DB_PASSWORD=%s\nSENTINEL_MIGRATE_ENV_FILE=.env.migrate\n' "$(secret)" >> .env
printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$migration" > .env.migrate
check "$migration"

step "A migration password put in .env by mistake does not reach web"
printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$migration" >> .env
check "$migration"

echo "Compose configuration checks passed"
