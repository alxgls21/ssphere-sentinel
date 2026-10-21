#!/usr/bin/env bash
# A new installation whose .env holds its address and nothing secret (docs/server-deployment.md), on real
# containers: the init service creates the secrets in ./secrets, private to the application and in no
# environment or log; the database is created without SENTINEL_POSTGRES_INITIALIZE; the setup code in the log
# of web creates the first administrator through the proxy, at the https address, after which setup is over;
# a second start changes nothing; and a database whose secrets were lost does not start with new ones.
#
# CI only: it writes .env and ./secrets in the working tree, uses sudo to read files of uid 10001, and removes
# the project and its volumes at the end.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "${CI:-}" = true ] || fail "CI only"
[ ! -e .env ] && [ ! -e secrets ] || fail ".env or ./secrets exists: run this on a fresh checkout"
trap 'docker compose down --volumes --remove-orphans > /dev/null 2>&1 || true; sudo rm -rf secrets secrets.lost; rm -f .env' EXIT

FILES=(django_secret_key agent_token_pepper postgres_password)
fingerprint() { sudo sha256sum "${FILES[@]/#/secrets/}"; }

step "An .env with the address and the PostgreSQL version, and nothing secret"
printf 'SENTINEL_URL=https://sentinel.example.test\nSENTINEL_POSTGRES=18\nSENTINEL_HTTP_BIND=127.0.0.1\n' > .env
scripts/postgres-preflight.sh
docker compose up --detach --build --wait --wait-timeout 300

step "The secrets: three files of the application's user, readable by it alone"
for file in "${FILES[@]}"; do
    [ "$(sudo stat -c '%u %g %a' "secrets/$file")" = "10001 10001 400" ] || fail "secrets/$file: $(sudo stat -c '%u %g %a' "secrets/$file")"
    [[ "$(sudo cat "secrets/$file")" =~ ^[A-Za-z0-9_-]{64}$ ]] || fail "secrets/$file is not a random secret"
done
[ -f secrets/initialize-database ] || fail "the new installation's database was not authorized"
grep -q 'secrets: created in /run/sentinel/secrets' <<<"$(docker compose logs init 2>&1)" || fail "init did not create the secrets"

step "No secret in the configuration or the environment of a container, nor in a log"
python3 - "${FILES[@]/#/secrets/}" <<'PY'
import json
import subprocess
import sys

secrets = [subprocess.run(["sudo", "cat", path], capture_output=True, text=True, check=True).stdout.strip()
           for path in sys.argv[1:]]
problems = []
ids = subprocess.run(["docker", "compose", "ps", "--all", "--quiet"], capture_output=True, text=True,
                     check=True).stdout.split()
for container in json.loads(subprocess.run(["docker", "inspect", *ids], capture_output=True, text=True,
                                           check=True).stdout):
    name = container["Name"]
    text = json.dumps(container["Config"])
    problems += [f"{name}: a secret in its configuration" for secret in secrets if secret in text]
    mounts = {mount["Destination"]: mount for mount in container["Mounts"]}
    reads = "/run/sentinel/secrets" in mounts
    if "proxy" in name and reads:
        problems.append(f"{name}: the proxy sees the secrets")
    if reads and mounts["/run/sentinel/secrets"]["RW"] and "init" not in name:
        problems.append(f"{name}: the secrets are writable")
logs = subprocess.run(["docker", "compose", "logs", "--no-color"], capture_output=True, text=True, check=True)
problems += ["a secret in the logs" for secret in secrets if secret in logs.stdout + logs.stderr]
if problems:
    sys.exit("FAIL: " + "; ".join(sorted(set(problems))))
print("no secret in any configuration, environment or log")
PY
# What a process reads from the files is in its own environment only.
docker compose exec -T web python -c 'import os, sys; sys.exit("DJANGO_SECRET_KEY" in os.environ)' \
    || fail "the secrets are in web's environment as Docker made it"

step "The first administrator, from the setup code in web's log, at the https address"
code=$(docker compose logs --no-color web 2>&1 | sed -n 's/.*setup:     \([2-9A-HJ-NP-Z-]*\)$/\1/p' | tail -n 1)
[[ $code =~ ^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$ ]] || fail "no setup code in web's log"
password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
SENTINEL_SETUP_CODE=$code SENTINEL_SETUP_PASSWORD=$password python3 - <<'PY'
import http.client
import json
import os
from http.cookies import SimpleCookie

HOST, ORIGIN = "sentinel.example.test", "https://sentinel.example.test"
cookies = {}


def call(method, path, payload=None, token=None):
    headers = {"Host": HOST, "Origin": ORIGIN, "Accept": "application/json"}
    if cookies:
        headers["Cookie"] = "; ".join(f"{name}={value}" for name, value in cookies.items())
    if token:
        headers["X-CSRFToken"] = token
    body = None
    if payload is not None:
        body = json.dumps(payload)
        headers["Content-Type"] = "application/json"
    connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=30)
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    data = response.read()
    for header in response.headers.get_all("Set-Cookie") or []:
        for name, morsel in SimpleCookie(header).items():
            if morsel.value:
                assert morsel["secure"], f"the {name} cookie of an https address is not Secure"
                cookies[name] = morsel.value
    return response.status, json.loads(data)


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


status, body = call("GET", "/api/v1/console/setup/")
check((status, body) == (200, {"required": True}), f"setup is not required: {status} {body}")
status, session = call("GET", "/api/v1/console/session/")
token = session["csrfToken"]
account = {"username": "owner", "email": "owner@example.test", "password": os.environ["SENTINEL_SETUP_PASSWORD"]}
status, body = call("POST", "/api/v1/console/setup/", {**account, "code": "AAAA-BBBB-CCCC"}, token)
check((status, body["error"]["code"]) == (400, "invalid_code"), f"a wrong code: {status} {body}")
status, body = call("POST", "/api/v1/console/setup/", {**account, "code": os.environ["SENTINEL_SETUP_CODE"]}, token)
check(status == 200 and body["authenticated"] is True, f"setup: {status} {body}")
status, body = call("GET", "/api/v1/console/servers/")
check(status == 200, f"the administrator's console: {status}")
status, body = call("GET", "/api/v1/console/setup/")
check(body == {"required": False}, "setup is still required")
status, body = call("POST", "/api/v1/console/setup/", {**account, "code": os.environ["SENTINEL_SETUP_CODE"]},
                    body.get("csrfToken") or token)
check(status in (403, 404), f"setup again: {status}")
print("the first administrator signed in; setup is over")
PY

step "A second start changes nothing, and prints no setup code"
before=$(fingerprint)
docker compose up --detach --wait --wait-timeout 300 --force-recreate web
[ "$(fingerprint)" = "$before" ] || fail "the secrets changed"
[ ! -e secrets/initialize-database ] || fail "the authorization to create the database outlived it"
# The logs are the recreated container's: an administrator exists, so it printed no code.
if docker compose logs --no-color web 2>&1 | grep -q 'setup: '; then
    fail "web printed a setup code although an administrator exists"
fi

step "A database whose secrets were lost does not start with new ones"
docker compose stop
sudo mv secrets secrets.lost
if docker compose up --detach --wait --wait-timeout 120 > /dev/null 2>&1; then
    fail "the stack started with new secrets for the old database"
fi
grep -q 'the database exists, but /run/sentinel/secrets holds none of its secrets' <<<"$(docker compose logs init 2>&1)" \
    || fail "init did not say why"
sudo rm -rf secrets  # the empty directory Docker made for the mount
sudo mv secrets.lost secrets
docker compose up --detach --wait --wait-timeout 300
[ "$(fingerprint)" = "$before" ] || fail "the restored secrets changed"
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8000/health/ready/

echo "first-run checks passed"
