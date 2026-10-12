# Server deployment (Docker Compose)

The server runs as two containers: `web` (Django on Gunicorn, non-root,
read-only filesystem) and `db` (PostgreSQL 16, not published on the host).
TLS is terminated in front of `web`: by Cloudflare Tunnel (no inbound ports)
or by a reverse proxy on the host. Replace `<tag>` with the release you deploy.

Requirements: Docker Engine 24+ with the Compose plugin (`docker compose`),
about 1 GB of RAM, and a DNS name for the server.

## 1. Configure

```bash
git clone https://github.com/alxgls21/ssphere-sentinel.git /opt/ssphere-sentinel
cd /opt/ssphere-sentinel
git checkout <tag>

cp .env.example .env
chmod 600 .env
```

Generate three different secrets and put them in `.env` as
`DJANGO_SECRET_KEY`, `AGENT_TOKEN_PEPPER` and `POSTGRES_PASSWORD`:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(50))'
```

Then set at least:

```dotenv
DJANGO_DEBUG=false
DJANGO_ALLOWED_HOSTS=sentinel.example.com
DJANGO_CSRF_TRUSTED_ORIGINS=https://sentinel.example.com
# Only the TLS front end (on this host) should reach the plain-HTTP port.
SENTINEL_HTTP_BIND=127.0.0.1
```

The server refuses to start with the example `DJANGO_SECRET_KEY` while
`DJANGO_DEBUG=false`. Choose the `AGENT_TOKEN_PEPPER` before creating agents:
changing it later invalidates every agent token.

## 2. Start

```bash
docker compose up -d --build
docker compose ps                     # both services "healthy"
curl -fsS http://127.0.0.1:8000/health/ready/
docker compose exec web python manage.py createsuperuser
```

On every start the `web` container waits for PostgreSQL and applies database
migrations before Gunicorn starts. Both services restart automatically
(`restart: unless-stopped`), also after a reboot of the Docker host.

Health endpoints, also used by the image's `HEALTHCHECK`:

| Endpoint | Meaning |
| --- | --- |
| `GET /health/` | Liveness: Gunicorn and Django answer (`{"status": "ok"}`) |
| `GET /health/ready/` | Readiness: the database is reachable (`200`, or `503 {"status": "unavailable"}`) |

They answer requests by IP address and over plain HTTP (no `ALLOWED_HOSTS`
check, no HTTPS redirect) and expose no configuration or error details.

## 3. HTTPS

Choose one front end. In both, HTTPS is enforced in front of Django; Django
uses Secure cookies and `DJANGO_CSRF_TRUSTED_ORIGINS` and does not need to
trust any forwarded header. See [security.md](security.md) for the trusted
proxy boundary if you want Django itself to redirect to HTTPS or send HSTS.

### Option A: Cloudflare Tunnel

No inbound port is opened on the host; `cloudflared` connects out to
Cloudflare and forwards requests to `web` over the internal Compose network.

1. In Cloudflare Zero Trust, create a tunnel (**Networks → Tunnels → Create a
   tunnel → Cloudflared**) and copy its token.
2. Add a **public hostname** to the tunnel: `sentinel.example.com`, service
   type `HTTP`, URL `web:8000`.
3. Store the token in its own file, so the `web` container never sees it:

   ```bash
   install -m 0600 /dev/null .env.tunnel
   echo 'TUNNEL_TOKEN=<tunnel-token>' > .env.tunnel
   ```

4. Start everything with the tunnel overlay:

   ```bash
   docker compose -f compose.yml -f compose.tunnel.yml up -d --build
   ```

5. In the Cloudflare dashboard for the zone, enable **SSL/TLS → Edge
   Certificates → Always Use HTTPS** and HSTS there.

Keep `DJANGO_SECURE_SSL_REDIRECT=false`: `cloudflared` reaches Gunicorn over
plain HTTP from an untrusted address, so Django sees `http` and a Django-side
redirect would loop. Cloudflare already redirects clients to HTTPS.

Agents are HTTP clients, not browsers. Make sure nothing on Cloudflare
challenges them: exempt `/api/v1/agent/` from Bot Fight Mode, managed
challenges and rate-limiting rules that could block a host sending a request
every 30 seconds, and do not put that path behind Cloudflare Access. You can
put `/admin/` behind Cloudflare Access for an extra login factor.

### Option B: reverse proxy on the host

Any TLS reverse proxy works. With [Caddy](https://caddyserver.com/), which
obtains certificates automatically:

```caddyfile
sentinel.example.com {
    reverse_proxy 127.0.0.1:8000
    header Strict-Transport-Security "max-age=31536000"
}
```

Caddy redirects HTTP to HTTPS and sends HSTS itself, so Django's redirect and
HSTS settings can stay off. Open ports 80 and 443 in the host firewall; port
8000 stays bound to `127.0.0.1` (`SENTINEL_HTTP_BIND`).

### Plain HTTP (testing only)

Without a front end, set `SENTINEL_HTTP_BIND=0.0.0.0` and, to log in to the
admin over `http://`, `DJANGO_SESSION_COOKIE_SECURE=false` and
`DJANGO_CSRF_COOKIE_SECURE=false`. Agent tokens and admin passwords then cross
the network unencrypted; the agent logs a warning for `http://` URLs.

## 4. Add monitored hosts

In the admin: add a **Server**, then an **Agent** for it (the token is shown
once), then optional **Network targets**. Install the agent on the host with
[agent-deployment.md](agent-deployment.md).

## Operations

### Logs

```bash
docker compose logs -f web    # Gunicorn and Django (stderr), errors with tracebacks
docker compose logs -f db
```

Container logs are rotated (5 × 10 MB per service). Django logs at
`DJANGO_LOG_LEVEL` (default `INFO`); 4xx responses such as `Unauthorized:
/api/v1/agent/heartbeat/` appear as warnings, server errors with a traceback.
Request headers, and therefore agent tokens, are never logged. Gunicorn
access logs are off by default; enable them with
`GUNICORN_CMD_ARGS=--access-logfile -` in `.env`.

### Upgrades

1. Back up the database (see [Backups](#backups)).
2. Review what changed, in particular new settings:

   ```bash
   cd /opt/ssphere-sentinel
   git fetch --tags
   git diff <current-tag> <new-tag> -- .env.example compose.yml
   ```

3. Deploy:

   ```bash
   git checkout <new-tag>
   docker compose up -d --build
   docker compose ps
   ```

Migrations run automatically when the new `web` container starts. To roll
back, check out the previous tag and restore the backup taken before the
upgrade: migrations are not guaranteed to be reversible.

### Database migrations

Applied automatically at container start. To inspect or run them by hand:

```bash
docker compose exec web python manage.py showmigrations
docker compose run --rm web python manage.py migrate
```

Always back up first. Native installations run `python manage.py migrate`
with the production environment loaded.

### Backups

`pg_dump` produces a consistent snapshot while the server runs:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    > "sentinel-$(date +%Y%m%d-%H%M%S).dump"
```

Restore into the existing database (stops the application meanwhile):

```bash
docker compose stop web
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
    < sentinel-<timestamp>.dump
docker compose start web
```

Schedule the dump (for example daily from cron, alongside the retention
commands in the README), copy it off the host and test a restore regularly.
Dumps contain hashes of admin passwords and agent tokens and all monitoring
data: store them encrypted with restricted access. Also back up `.env` (and
`.env.tunnel`) separately and securely; without `AGENT_TOKEN_PEPPER` every
agent token must be regenerated.

The `postgres_data` volume must survive upgrades. `docker compose down`
keeps it; `docker compose down --volumes` deletes the database.

### PostgreSQL major versions

The Compose file pins PostgreSQL 16. A newer major version cannot open the
existing data volume: upgrade by dumping, starting a new volume with the new
version and restoring the dump, never by changing the image tag alone.

### Retention

Run the purge commands daily (see "Data retention and history" in the
README):

```bash
docker compose exec -T web python manage.py purge_network_measurements
docker compose exec -T web python manage.py purge_absent_docker_containers
```

### Resources

The defaults suit small installations (two Gunicorn workers, about 60 MB
each). Set `WEB_CONCURRENCY` in `.env` for more workers. To cap memory, add a
`deploy.resources.limits.memory` entry to the services in a
`compose.override.yml`.

Secret rotation, troubleshooting and known limitations:
[operations.md](operations.md) and [security.md](security.md).
