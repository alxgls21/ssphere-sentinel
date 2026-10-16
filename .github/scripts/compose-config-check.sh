#!/usr/bin/env bash
# Resolves the Compose configuration, without starting anything, with the .env
# of an existing installation (tests/deployment/legacy.env.example), of a new
# installation (.env.example) and of separate database roles, and checks that
#   - each one resolves (Compose before 2.24 refuses an env_file listed twice);
#   - an existing installation resolves the database service it always ran;
#   - with separate roles each service gets its own password only: web the
#     runtime login's, migrate the migration login's, db the bootstrap
#     superuser's, from the file only Compose reads;
#   - sentinel/db_roles.py reads the passwords from the resolved configuration,
#     and refuses one that gives web or migrate a password not its own.
# Writes and removes .env, .env.migrate and .env.bootstrap in the working tree: CI only.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ ! -e .env ] && [ ! -e .env.migrate ] && [ ! -e .env.bootstrap ] \
    || fail ".env, .env.migrate or .env.bootstrap exists: run this on a fresh checkout"
work=$(mktemp -d)
trap 'rm -rf "$work"; rm -f .env .env.migrate .env.bootstrap' EXIT

secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
env_from() {  # env_from <example>: the example with random secrets, as .env
    sed -e "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=$(secret)|" \
        -e "s|^AGENT_TOKEN_PEPPER=.*|AGENT_TOKEN_PEPPER=$(secret)|" \
        -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
        "$1" > .env
}

# check <legacy|separate>: the resolved services and who gets which password.
# The passwords to look for come in MIGRATION, RUNTIME and BOOTSTRAP.
check() {
    docker compose config --quiet
    docker compose config --format json > "$work/config.json"
    python3 - "$work/config.json" "$1" <<'PY'
import json
import os
import sys

sys.path.insert(0, ".")
from sentinel.database import foreign_passwords  # noqa: E402

services = json.load(open(sys.argv[1]))["services"]
layout = sys.argv[2]
assert set(services) == {"db", "migrate", "web"}, sorted(services)
web, migrate, db = (services[name]["environment"] for name in ("web", "migrate", "db"))
assert web.get("DJANGO_SECRET_KEY") and migrate.get("DJANGO_SECRET_KEY"), "the env files were not resolved"
assert (web["SENTINEL_DB_ACCESS"], migrate["SENTINEL_DB_ACCESS"]) == ("runtime", "migrate")
assert services["web"]["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
assert not web.get("SENTINEL_DB_MIGRATE_PASSWORD"), "web receives the migration password"
assert not migrate.get("SENTINEL_DB_PASSWORD"), "migrate receives the runtime password"
assert (migrate.get("SENTINEL_DB_MIGRATE_PASSWORD") or "") == os.environ.get("MIGRATION", ""), "migrate lacks its password"
assert db["POSTGRES_PASSWORD"] == os.environ["BOOTSTRAP"], "db lacks the bootstrap password"
if layout == "separate":
    assert not web.get("POSTGRES_PASSWORD"), "web receives the bootstrap password"
    assert not migrate.get("POSTGRES_PASSWORD"), "migrate receives the bootstrap password"
    assert web.get("SENTINEL_DB_PASSWORD") == os.environ["RUNTIME"], "web lacks its password"
    assert foreign_passwords(web) == [] and foreign_passwords(migrate) == [], "a process would refuse to start"
else:
    assert web.get("POSTGRES_PASSWORD") == os.environ["BOOTSTRAP"], "web lacks the one login's password"
print("resolved:", ", ".join(sorted(services)))
PY
}

# separate_env: the .env in place moved to the separate logins, as
# docs/server-deployment.md describes: its bootstrap password into .env.bootstrap,
# the migration password (MIGRATION) into .env.migrate, the runtime's (RUNTIME) into .env.
separate_env() {
    grep '^POSTGRES_PASSWORD=' .env > .env.bootstrap
    sed -i '/^POSTGRES_PASSWORD=/d' .env
    printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$MIGRATION" > .env.migrate
    printf 'SENTINEL_DB_ROLES=separate\nSENTINEL_DB_PASSWORD=%s\nSENTINEL_BOOTSTRAP_ENV_FILE=.env.bootstrap\nSENTINEL_MIGRATE_ENV_FILE=.env.migrate\n' \
        "$RUNTIME" >> .env
}
bootstrap_of() { sed -n 's/^POSTGRES_PASSWORD=//p' "$1"; }

docker compose version

step "An existing installation: its unchanged .env"
env_from tests/deployment/legacy.env.example
BOOTSTRAP=$(bootstrap_of .env) MIGRATION="" check legacy
[ "$(docker compose config --hash db)" = \
    "$(docker compose --file tests/deployment/postgres16-reference.yml --project-directory . config --hash db)" ] \
    || fail "the PostgreSQL 16 service differs from the one earlier releases ran"

step "A new installation: .env.example"
env_from .env.example
BOOTSTRAP=$(bootstrap_of .env) MIGRATION="" check legacy

export RUNTIME MIGRATION BOOTSTRAP
RUNTIME=$(secret)
MIGRATION=$(secret)

step "Separate database roles: each password in its own file"
env_from tests/deployment/legacy.env.example
separate_env
BOOTSTRAP=$(bootstrap_of .env.bootstrap)
check separate
docker compose config --format json \
    | python3 -m sentinel.db_roles apply --compose-config - > "$work/program" \
    || fail "the generator refused the configuration"
grep -q '^\\echo sentinel-roles: committed ' "$work/program" || fail "no program"
for value in "$RUNTIME" "$MIGRATION" "$BOOTSTRAP"; do
    if grep -qF "$value" "$work/program"; then fail "the program holds a password"; fi
done

step "Moving the bootstrap password leaves the db service as it was"
env_from tests/deployment/legacy.env.example
legacy_hash=$(docker compose config --hash db)
separate_env
BOOTSTRAP=$(bootstrap_of .env.bootstrap)
[ "$(docker compose config --hash db)" = "$legacy_hash" ] || fail "the db service changes"

step "Passwords put in .env by mistake"
printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$MIGRATION" >> .env
check separate
cat .env.bootstrap >> .env
docker compose config --format json > "$work/config.json"
if python3 -m sentinel.db_roles apply --compose-config "$work/config.json" > /dev/null 2> "$work/refused"; then
    fail "the generator accepted web and migrate with the bootstrap password"
fi
grep -q 'the web service would get POSTGRES_PASSWORD' "$work/refused" || fail "no reason given"
python3 - "$work/config.json" <<'PY'
import json
import sys

sys.path.insert(0, ".")
from sentinel.database import foreign_passwords  # noqa: E402

services = json.load(open(sys.argv[1]))["services"]
for name in ("web", "migrate"):
    assert foreign_passwords(services[name]["environment"]) == ["POSTGRES_PASSWORD"], name
print("web and migrate would refuse to start")
PY

echo "Compose configuration checks passed"
