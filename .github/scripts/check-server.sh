#!/usr/bin/env bash
# Checks against the running Compose stack (docker compose up --wait), through
# the published port: the proxy service, which serves the console and passes
# the rest on to web. With the .env made by ci-env.sh, a browser signs in as
# it does behind TLS: the public name sentinel.example.test, an https Origin
# (DJANGO_CSRF_TRUSTED_ORIGINS); with any other .env (the update rehearsal's),
# at http://127.0.0.1:8000.
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
# So does nginx, as the image's unprivileged user (which owns /etc/nginx: only the read-only fs stops it).
uid=$(docker compose exec -T proxy id -u)
[ "$uid" = "101" ] || fail "proxy runs as uid $uid"
[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$(docker compose ps --quiet proxy)")" = true ] \
    || fail "the proxy's root filesystem is writable"
if docker compose exec -T proxy sh -c 'touch /etc/nginx/write-probe' 2>/dev/null; then
    fail "the proxy's root filesystem is writable"
fi

# Only the proxy is published: neither web nor PostgreSQL is reachable from the host.
# (Not `docker compose port`: for a port the image exposes but nothing publishes it prints ":0".)
bindings() { docker inspect --format '{{json .HostConfig.PortBindings}}' "$(docker compose ps --quiet "$1")"; }
case "$(bindings web)" in '{}' | null) ;; *) fail "web is published on the host: $(bindings web)" ;; esac
if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then
    fail "PostgreSQL is published on the host"
fi
# The proxy is on the edge network alone and reaches web there; the database is not on it.
networks() { docker inspect --format '{{range $name, $network := .NetworkSettings.Networks}}{{$name}} {{end}}' "$(docker compose ps --quiet "$1")"; }
[[ "$(networks proxy)" =~ ^[^\ ]+_edge\ $ ]] || fail "the proxy is on the networks $(networks proxy)"
[[ " $(networks db)" != *_edge\ * ]] || fail "the database is on the edge network"
docker compose exec -T proxy wget -q -T 5 -O /dev/null http://web:8000/health/ || fail "the proxy does not reach web"

# A console user, to sign in through the proxy (console and admin), removed
# afterwards; its password is random and masked in the log.
password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::add-mask::$password"; fi
docker compose exec -T -e DJANGO_SUPERUSER_PASSWORD="$password" web \
    python manage.py createsuperuser --noinput --username ci-proxy --email ci-proxy@example.invalid > /dev/null

public=127.0.0.1:8000 scheme=http
if grep -qx 'DJANGO_CSRF_TRUSTED_ORIGINS=https://sentinel.example.test' .env; then
    public=sentinel.example.test scheme=https
fi
echo "signing in at $scheme://$public"

SENTINEL_CHECK_PASSWORD=$password SENTINEL_CHECK_HOST=$public SENTINEL_CHECK_SCHEME=$scheme python3 - <<'PY'
"""The console, its API, the admin and the agent API through the proxy, as a browser and an agent use them."""

import http.client
import json
import os
import re
from http.cookies import SimpleCookie

PUBLIC = os.environ["SENTINEL_CHECK_HOST"]
ORIGIN = f"{os.environ['SENTINEL_CHECK_SCHEME']}://{PUBLIC}"
PASSWORD = os.environ["SENTINEL_CHECK_PASSWORD"]


def request(method, path, body=None, headers=None, host=PUBLIC):
    connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=30)
    connection.request(method, path, body=body, headers={"Host": host, **(headers or {})})
    response = connection.getresponse()
    data = response.read()
    connection.close()
    return response, data


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


class Browser:
    """Cookies as a browser keeps them for ORIGIN (an https one, or localhost, where Secure cookies are sent)."""

    def __init__(self):
        self.cookies = {}

    def send(self, method, path, body=None, headers=None):
        headers = dict(headers or {})
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{name}={value}" for name, value in self.cookies.items())
        response, data = request(method, path, body, headers)
        for header in response.headers.get_all("Set-Cookie") or []:
            for name, morsel in SimpleCookie(header).items():
                if not morsel.value:  # removed (sign-out)
                    self.cookies.pop(name, None)
                    continue
                check(morsel["secure"], f"the {name} cookie is not Secure")
                self.cookies[name] = morsel.value
        return response, data

    def api(self, method, path, payload=None, token=None, origin=ORIGIN):
        headers = {"Accept": "application/json", "Origin": origin}
        body = None
        if payload is not None:
            body = json.dumps(payload)
            headers["Content-Type"] = "application/json"
        if token:
            headers["X-CSRFToken"] = token
        response, data = self.send(method, path, body, headers)
        return response, json.loads(data)


# The console: index.html for every route of its own, with the security headers, never cached.
response, index = request("GET", "/")
check(response.status == 200 and response.headers["Content-Type"].startswith("text/html"), "/ is not the console")
check(b'<div id="root">' in index, "/ is not the console's index.html")
policy = response.headers.get("Content-Security-Policy", "")
check("default-src 'self'" in policy and "frame-ancestors 'none'" in policy, f"console CSP: {policy!r}")
check(response.headers.get("X-Frame-Options") == "DENY", "X-Frame-Options is missing")
check(response.headers.get("X-Content-Type-Options") == "nosniff", "X-Content-Type-Options is missing")
check(response.headers.get("Cache-Control") == "no-cache", "index.html may be cached")
check("nginx/" not in response.headers.get("Server", ""), "the proxy names its version")
for route in ("/login", "/servers/00000000-0000-0000-0000-000000000000", "/settings/notifications"):
    response, data = request("GET", route)
    check(response.status == 200 and data == index, f"{route} is not the console's index.html")

# Its files: hashed names, kept for good; a missing one is a 404, not index.html.
assets = re.findall(rb'(?:src|href)="(/assets/[^"]+)"', index)
check(assets, "index.html names no asset")
for asset in assets:
    response, _ = request("GET", asset.decode())
    check(response.status == 200, f"{asset!r}: {response.status}")
    check("immutable" in response.headers.get("Cache-Control", ""), f"{asset!r} is not cached for good")
    check("Content-Security-Policy" in response.headers, f"{asset!r} lacks the security headers")
response, _ = request("GET", "/assets/missing-0000.js")
check(response.status == 404, f"a missing asset answers {response.status}")

# The console API: session bootstrap, sign-in, a signed-in call, sign-out. Behind TLS the browser's
# Origin is https while the request is plain HTTP: DJANGO_CSRF_TRUSTED_ORIGINS lets it through.
browser = Browser()
response, body = browser.api("GET", "/api/v1/console/session/")
check(response.status == 200 and body["authenticated"] is False, f"session: {response.status} {body}")
check("csrftoken" in browser.cookies, "the session bootstrap set no CSRF cookie")
token = body["csrfToken"]
response, body = browser.api("POST", "/api/v1/console/auth/login/", {"username": "ci-proxy", "password": PASSWORD})
check(response.status == 403 and body["error"]["code"] == "csrf_failed", "a sign-in without the CSRF token passed")
response, body = browser.api("POST", "/api/v1/console/auth/login/", {"username": "ci-proxy", "password": PASSWORD},
                             token, origin="https://elsewhere.example.test")
check(response.status == 403, f"a sign-in from another site answered {response.status}")
# A client's X-Forwarded-Proto does not make Django take the request for HTTPS (no trusted proxy by default):
# an https Origin of a name that is not trusted stays refused.
spoofed = Browser()
response, body = spoofed.api("GET", "/api/v1/console/session/")
response, data = request("POST", "/api/v1/console/auth/login/",
                         json.dumps({"username": "ci-proxy", "password": PASSWORD}),
                         {"Content-Type": "application/json", "Origin": "https://localhost", "X-Forwarded-Proto": "https",
                          "X-CSRFToken": body["csrfToken"], "Cookie": f"csrftoken={spoofed.cookies['csrftoken']}"},
                         host="localhost")
check(response.status == 403, f"X-Forwarded-Proto from a client was believed: {response.status}")
response, body = browser.api("POST", "/api/v1/console/auth/login/", {"username": "ci-proxy", "password": PASSWORD}, token)
check(response.status == 200 and body["authenticated"] is True, f"sign-in: {response.status} {body}")
check("sessionid" in browser.cookies, "sign-in set no session cookie")
token = body["csrfToken"]  # sign-in rotates it
response, body = browser.api("GET", "/api/v1/console/session/")
check(body["authenticated"] is True, "the session cookie did not sign the next request in")
response, body = browser.api("GET", "/api/v1/console/servers/")
check(response.status == 200 and "items" in body, f"a signed-in API call: {response.status}")
response, body = browser.api("POST", "/api/v1/console/auth/logout/", {}, token)
check(response.status == 200 and body["authenticated"] is False, f"sign-out: {response.status} {body}")

# The Django admin, signed in with its own form through the proxy.
admin = Browser()
response, page = admin.send("GET", "/admin/login/")
check(response.status == 200, f"/admin/login/: {response.status}")
middleware_token = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', page)[1].decode()
form = f"csrfmiddlewaretoken={middleware_token}&username=ci-proxy&password={PASSWORD}&next=/admin/"
response, _ = admin.send("POST", "/admin/login/?next=/admin/", form,
                         {"Content-Type": "application/x-www-form-urlencoded", "Origin": ORIGIN,
                          "Referer": f"{ORIGIN}/admin/login/"})
check(response.status == 302 and response.headers["Location"] == "/admin/", f"admin sign-in: {response.status}")
response, _ = admin.send("GET", "/admin/")
check(response.status == 200, f"/admin/ after sign-in: {response.status}")

# The agent API: the bearer token passes through to Django. A heartbeat of the agent's largest size is within
# the proxy's limit, which nginx checks before anything else (on a path it serves itself, so that no early
# answer from Django races the upload); the agent's own heartbeats follow (agent-systemd-e2e.sh).
response, data = request("POST", "/api/v1/agent/heartbeat/", b"{}",
                         {"Content-Type": "application/json", "Authorization": "Bearer not-a-token"})
check(response.status == 401, f"agent API without a valid token: {response.status}")
response, data = request("POST", "/", b" " * 2_500_000, {"Content-Type": "application/json"})
check(response.status != 413, "the proxy refuses a heartbeat of the agent's largest size")
# nginx refuses a larger one from its Content-Length alone, before the body is sent.
response, data = request("POST", "/", None, {"Content-Type": "application/json", "Content-Length": str(3 * 1024 * 1024 + 1)})
check(response.status == 413, f"the proxy has no body size limit ({response.status})")
print("console, console API, admin and agent API pass through the proxy")
PY
# The database as it was: the user and the sessions it signed in with (the rehearsals compare row counts).
docker compose exec -T web python manage.py shell --no-imports -v 0 -c \
    "from django.contrib.auth import get_user_model; from django.contrib.sessions.models import Session; user = get_user_model().objects.get(username='ci-proxy'); [session.delete() for session in Session.objects.all() if session.get_decoded().get('_auth_user_id') == str(user.pk)]; user.delete()" \
    < /dev/null > /dev/null

# Django's deployment checks pass (HSTS/SSL-redirect warnings are expected:
# they depend on how TLS is terminated in front of the server).
docker compose exec -T web python manage.py check --deploy
echo "server checks passed"
