#!/usr/bin/env bash
# Resolves the Compose configuration, without starting anything, with the .env
# of an existing installation (tests/deployment/legacy.env.example), of a new
# installation (.env.example) and of separate database roles, and checks that
#   - each one resolves (Compose before 2.24 refuses an env_file listed twice);
#   - an existing installation resolves the database service it always ran;
#   - with separate roles each service gets its own password only: web and
#     the alert engine the runtime login's, migrate the migration login's, db
#     the bootstrap superuser's, from the file only Compose reads;
#   - the alert engine runs as a worker, which never migrates, and the SMTP
#     password reaches the notifier only (profile "notifications"), not the
#     domain verifier (profile "web-monitoring");
#   - sentinel/db_roles.py reads the passwords from the resolved configuration,
#     and refuses one that gives web or migrate a password not its own;
#   - the proxy service alone is published, holds no secret and shares the edge
#     network with web only; with compose.tunnel.yml, cloudflared joins it there.
# Writes and removes .env, .env.migrate, .env.bootstrap and .env.tunnel in the working tree: CI only.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ ! -e .env ] && [ ! -e .env.migrate ] && [ ! -e .env.bootstrap ] && [ ! -e .env.tunnel ] \
    || fail ".env, .env.migrate, .env.bootstrap or .env.tunnel exists: run this on a fresh checkout"
work=$(mktemp -d)
trap 'rm -rf "$work"; rm -f .env .env.migrate .env.bootstrap .env.tunnel' EXIT

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
assert set(services) - {"init"} == {"db", "migrate", "web", "alert-engine", "proxy"}, sorted(services)
# The init service (the secrets of a new installation) comes with PostgreSQL 18 only.
assert ("init" in services) == services["db"]["image"].startswith("postgres:18"), sorted(services)
# The front door: the proxy alone is published; it holds no secret and reaches web, not the database.
assert [name for name, service in services.items() if service.get("ports")] == ["proxy"], "another service is published"
assert [port["target"] for port in services["proxy"]["ports"]] == [8080]
assert not services["proxy"].get("environment") and not services["proxy"].get("env_file"), "the proxy has settings"
assert set(services["proxy"]["networks"]) == {"edge"} and set(services["web"]["networks"]) == {"default", "edge"}
assert "edge" not in services["db"].get("networks", {"default": None}), "the database is on the edge network"
assert services["proxy"]["depends_on"]["web"]["condition"] == "service_healthy"
web, migrate, db, engine = (services[name]["environment"] for name in ("web", "migrate", "db", "alert-engine"))
assert web.get("DJANGO_SECRET_KEY") and migrate.get("DJANGO_SECRET_KEY"), "the env files were not resolved"
assert (web["SENTINEL_DB_ACCESS"], migrate["SENTINEL_DB_ACCESS"]) == ("runtime", "migrate")
assert services["web"]["depends_on"]["migrate"]["condition"] == "service_completed_successfully"
assert not web.get("SENTINEL_DB_MIGRATE_PASSWORD"), "web receives the migration password"
assert not migrate.get("SENTINEL_DB_PASSWORD"), "migrate receives the runtime password"
assert (engine["SENTINEL_DB_ACCESS"], engine["SENTINEL_PROCESS"]) == ("runtime", "worker"), "the alert engine could migrate"
assert {name: condition["condition"] for name, condition in services["alert-engine"]["depends_on"].items()} == {
    "db": "service_healthy", "migrate": "service_completed_successfully", "web": "service_started"}
assert not engine.get("SENTINEL_DB_MIGRATE_PASSWORD"), "the alert engine receives the migration password"
assert engine.get("SENTINEL_DB_PASSWORD", "") == web.get("SENTINEL_DB_PASSWORD", ""), "the alert engine logs in otherwise"
assert engine.get("POSTGRES_PASSWORD", "") == web.get("POSTGRES_PASSWORD", ""), "the alert engine logs in otherwise"
for name in ("web", "migrate", "alert-engine"):
    assert not services[name]["environment"].get("SENTINEL_SMTP_PASSWORD"), f"{name} receives the SMTP password"
assert (migrate.get("SENTINEL_DB_MIGRATE_PASSWORD") or "") == os.environ.get("MIGRATION", ""), "migrate lacks its password"
assert db["POSTGRES_PASSWORD"] == os.environ["BOOTSTRAP"], "db lacks the bootstrap password"
if layout == "separate":
    assert not web.get("POSTGRES_PASSWORD"), "web receives the bootstrap password"
    assert not migrate.get("POSTGRES_PASSWORD"), "migrate receives the bootstrap password"
    assert web.get("SENTINEL_DB_PASSWORD") == os.environ["RUNTIME"], "web lacks its password"
    assert foreign_passwords(web) == [] and foreign_passwords(migrate) == [], "a process would refuse to start"
    assert foreign_passwords(engine) == [], "the alert engine would refuse to start"
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

step "Email notifications: the SMTP password reaches the notifier only"
SMTP=$(secret)
printf 'SENTINEL_SMTP_HOST=smtp.example.com\nSENTINEL_EMAIL_FROM=sentinel@example.com\nSENTINEL_SMTP_USER=sentinel\nSENTINEL_SMTP_PASSWORD=%s\n' \
    "$SMTP" >> .env
check separate  # without the profile, no notifier, and nobody gets it
COMPOSE_PROFILES=notifications docker compose config --format json > "$work/config.json"
SMTP=$SMTP python3 - "$work/config.json" <<'PY'
import json
import os
import sys

sys.path.insert(0, ".")
from sentinel.database import foreign_passwords  # noqa: E402

services = json.load(open(sys.argv[1]))["services"]
assert set(services) - {"init"} == {"db", "migrate", "web", "alert-engine", "proxy", "notifier"}, sorted(services)
# The init service (the secrets of a new installation) comes with PostgreSQL 18 only.
assert ("init" in services) == services["db"]["image"].startswith("postgres:18"), sorted(services)
holders = sorted(name for name, service in services.items()
                 if (service.get("environment") or {}).get("SENTINEL_SMTP_PASSWORD"))
assert holders == ["notifier"], holders
notifier = services["notifier"]["environment"]
assert notifier["SENTINEL_SMTP_PASSWORD"] == os.environ["SMTP"], "the notifier lacks its SMTP password"
assert (notifier["SENTINEL_DB_ACCESS"], notifier["SENTINEL_PROCESS"]) == ("runtime", "worker")
assert notifier.get("SENTINEL_DB_PASSWORD") == os.environ["RUNTIME"], "the notifier lacks the runtime password"
assert foreign_passwords(notifier) == [], "the notifier would refuse to start"
print("the SMTP password reaches: notifier")
PY
python3 -m sentinel.db_roles apply --compose-config "$work/config.json" > "$work/program" \
    || fail "the generator refused the configuration with the notifier"
if grep -qF "$SMTP" "$work/program"; then fail "the program holds the SMTP password"; fi

step "Website monitoring: the domain verifier logs in as web does, without the SMTP password"
COMPOSE_PROFILES=notifications,web-monitoring docker compose config --format json > "$work/config.json"
python3 - "$work/config.json" <<'PY'
import json
import os
import sys

sys.path.insert(0, ".")
from sentinel.database import foreign_passwords  # noqa: E402

services = json.load(open(sys.argv[1]))["services"]
assert set(services) - {"init"} == {"db", "migrate", "web", "alert-engine", "proxy", "notifier", "domain-verifier"}, sorted(services)
# The init service (the secrets of a new installation) comes with PostgreSQL 18 only.
assert ("init" in services) == services["db"]["image"].startswith("postgres:18"), sorted(services)
verifier = services["domain-verifier"]["environment"]
assert (verifier["SENTINEL_DB_ACCESS"], verifier["SENTINEL_PROCESS"]) == ("runtime", "worker")
assert verifier.get("SENTINEL_DB_PASSWORD") == os.environ["RUNTIME"], "the verifier lacks the runtime password"
assert not verifier.get("SENTINEL_SMTP_PASSWORD"), "the verifier gets the SMTP password"
assert foreign_passwords(verifier) == [], "the verifier would refuse to start"
print("the domain verifier: runtime login, no SMTP password")
PY
python3 -m sentinel.db_roles apply --compose-config "$work/config.json" > /dev/null \
    || fail "the generator refused the configuration with the domain verifier"

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

step "Cloudflare Tunnel: cloudflared reaches the proxy on the edge network, with its own token only"
printf 'TUNNEL_TOKEN=%s\n' "$(secret)" > .env.tunnel
docker compose -f compose.yml -f compose.tunnel.yml config --format json > "$work/config.json"
python3 - "$work/config.json" <<'PY'
import json
import sys

services = json.load(open(sys.argv[1]))["services"]
tunnel = services["cloudflared"]
assert set(tunnel["networks"]) == {"edge"}, tunnel["networks"]
assert {name: dep["condition"] for name, dep in tunnel["depends_on"].items()} == {"proxy": "service_healthy"}
assert not tunnel.get("ports"), "cloudflared is published"
assert tunnel["environment"].get("TUNNEL_TOKEN"), "cloudflared lacks its token"
holders = sorted(name for name, service in services.items() if (service.get("environment") or {}).get("TUNNEL_TOKEN"))
assert holders == ["cloudflared"], holders
print("cloudflared: edge network, after the proxy, the only holder of the tunnel token")
PY

echo "Compose configuration checks passed"
