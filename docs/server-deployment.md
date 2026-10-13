# Server deployment (Docker Compose)

The server runs as two containers: `web` (Django on Gunicorn, non-root,
read-only filesystem) and `db` (PostgreSQL, not published on the host: 18 for
new installations, see [PostgreSQL versions](#postgresql-versions)).
TLS is terminated in front of `web`: by Cloudflare Tunnel (no inbound ports)
or by a reverse proxy on the host. Replace `<tag>` with the release you deploy.

Requirements: Docker Engine 24+ with Docker Compose 2.24 or later
(`docker compose`), about 1 GB of RAM, and a DNS name for the server.

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
# First start of a new installation only; remove it afterwards.
SENTINEL_POSTGRES_INITIALIZE=true
```

PostgreSQL 18 creates its empty database only when `SENTINEL_POSTGRES_INITIALIZE=true`
authorizes it (see [PostgreSQL versions](#postgresql-versions)).

The server refuses to start with the example `DJANGO_SECRET_KEY` while
`DJANGO_DEBUG=false`. Choose the `AGENT_TOKEN_PEPPER` before creating agents:
changing it later invalidates every agent token.

## 2. Start

```bash
scripts/postgres-preflight.sh         # read-only check of the database volumes
docker compose up -d --build
docker compose ps                     # both services "healthy"
curl -fsS http://127.0.0.1:8000/health/ready/
docker compose exec web python manage.py createsuperuser
```

Once the first start has succeeded, delete the `SENTINEL_POSTGRES_INITIALIZE`
line from `.env` and run `docker compose up -d` (the `db` container is
recreated once, its data is not touched). From then on a missing database
volume stops the database instead of silently creating an empty one.

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
   scripts/postgres-preflight.sh
   docker compose up -d --build
   docker compose ps
   ```

Migrations run automatically when the new `web` container starts. To roll
back, check out the previous tag and restore the backup taken before the
upgrade: migrations are not guaranteed to be reversible.

Updating the repository never changes the database version of an existing
installation: the `db` service follows the `SENTINEL_POSTGRES` setting of your
`.env`, and an `.env` made before PostgreSQL 18 became the default has none,
so `db` stays on PostgreSQL 16 with its current volume. Do not copy that
setting from `.env.example` into an existing installation; follow
[Moving an existing installation to PostgreSQL 18](#moving-an-existing-installation-to-postgresql-18).

**After upgrading to the release that adds the console's server and container
views**, servers and network targets have no site yet, so only users who may
see all customers can see them. In the admin, filter *Servers* and *Network
targets* by *Site: Empty* and set each one's site from the list; restricted
console users see a server as soon as it has a site they are granted.

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

The database volume (`postgres18_data`, or `postgres_data` on an installation
that still runs PostgreSQL 16) must survive upgrades. `docker compose down`
keeps it; `docker compose down --volumes` deletes the database.

### PostgreSQL versions

| | New installation | Existing installation |
| --- | --- | --- |
| Image | `postgres:18-alpine` | `postgres:16-alpine` |
| Volume | `postgres18_data`, mounted at `/var/lib/postgresql` | `postgres_data`, mounted at `/var/lib/postgresql/data` |
| Selected by | `SENTINEL_POSTGRES=18`, the line `.env.example` contains | no `SENTINEL_POSTGRES` line in `.env` (or `SENTINEL_POSTGRES=16`) |

Both are supported. The image, the volume and the mount of each major version
are defined together in `deploy/postgres/postgres-<version>.yml`, and
`SENTINEL_POSTGRES` only chooses the file, so they cannot be combined wrongly.
A value without a file (for example `17`) stops Compose with a "no such file"
error before anything is started.

PostgreSQL 18 stores its cluster in a directory named after the major version
(`/var/lib/postgresql/18/docker`) below a single mount point, which is what lets
a later major upgrade use `pg_upgrade`. A PostgreSQL 18 container started on a
PostgreSQL 16 volume refuses to initialise it and exits with an error that
names the old data; PostgreSQL 16 cannot read a PostgreSQL 18 cluster at all.
The refused start may leave an empty `18/docker` directory in the volume. It is
harmless and can be removed.

To see which version an installation runs:

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW server_version"'
```

#### Initialization guard

The PostgreSQL 18 service starts an existing cluster without any setting, but
it creates an empty database only when `SENTINEL_POSTGRES_INITIALIZE=true` is
set. A new installation sets it for its first start (the line is in
`.env.example`, commented out on purpose: copying the version line into an
existing installation must not carry the authorization along) and so does step
2 of the migration below. Without it the container exits with a message and
nothing is initialized. Remove the line once the database exists.

#### Preflight check

`scripts/postgres-preflight.sh` compares the version `SENTINEL_POSTGRES`
selects with the database volumes Docker has for the project, using only
`docker compose config`, `docker volume ls` and `docker volume inspect`. It
never creates, changes or removes a volume and does not read database files.
Run it from the project directory, in the environment you run `docker compose`
in, before starting the stack:

| Volumes that exist | Selected | Result |
| --- | --- | --- |
| none | 16 or 18 | OK: a new installation |
| PostgreSQL 16 only | 16 | OK: existing installation |
| PostgreSQL 16 only | 18 | **Refused**: it would create an empty database next to your data. `--migrate` authorizes it for step 2 of the migration only |
| PostgreSQL 18 only | 18 | OK: existing installation |
| PostgreSQL 18 only | 16 | **Refused**: it would create an empty PostgreSQL 16 database |
| both | 16 or 18 | **Ambiguous** (exit status 2): one volume is a copy kept for rollback. `--confirm <version>`, equal to the selected one, says which database you mean to start |

Exit status: 0 safe, 1 refused, 2 ambiguous, 3 the state could not be
determined (Docker not reachable, configuration that does not resolve).
Switching versions is only possible through the migration or the rollback
below, which call it with `--migrate` and `--confirm`.

#### What these checks cannot guarantee

Compose has no hook that could make `docker compose up` run the preflight, so
**starting the stack directly with `docker compose up` is not guaranteed safe
against every wrong version switch.** In particular:

- With both volumes present, nothing stops `docker compose up` from starting
  PostgreSQL 16 on the old volume after a completed migration: it would serve
  the data as it was before the migration. Only the preflight and
  `SENTINEL_POSTGRES` staying in `.env` prevent it.
- With only the PostgreSQL 18 volume present, selecting 16 creates an empty
  PostgreSQL 16 database.
- Authorization given in `.env` is honoured: if `SENTINEL_POSTGRES=18` and
  `SENTINEL_POSTGRES_INITIALIZE=true` are both added to an existing
  PostgreSQL 16 installation, an empty PostgreSQL 18 database is created next
  to the old one (your data stays in the old volume, `SENTINEL_POSTGRES` back
  out of `.env` returns to it).
- A volume that exists is taken to hold a database, whatever it contains. A
  refused first start leaves an empty volume behind (Compose creates it before
  the container refuses); the preflight then reports it as an installation.
  Check that it is empty before removing it (`docker run --rm -v <volume>:/v:ro
  postgres:18-alpine ls -A /v`), and only then `docker volume rm <volume>`.
- The preflight does not look inside volumes, so it cannot tell a healthy
  database from a damaged one. Restore tests and the checks in the migration
  procedure do.

### Moving an existing installation to PostgreSQL 18

Dump the database, restore it into a new PostgreSQL 18 volume and keep the
PostgreSQL 16 volume untouched until the new database has proved itself. Plan
a maintenance window: monitoring data is not collected while the application
is stopped (agents keep queueing network measurements, see
[operations.md](operations.md)), and the length of the window is the time to
dump and restore the database, which you can measure on a copy. Check that the
host has room for the dump plus a second copy of the database.

The CI pipeline rehearses this procedure on every change
(`.github/scripts/postgres-upgrade-e2e.sh`); still, run it on a copy of your
data first if you can.

**1. Stop the application, back up and record what to compare**

```bash
cd /opt/ssphere-sentinel
git checkout <tag>                 # a release that includes PostgreSQL 18 support
docker compose build web
scripts/postgres-preflight.sh      # expected: existing PostgreSQL 16 installation
docker compose stop web

docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    > sentinel-pg16.dump
docker compose exec -T db sh -c 'pg_restore --list' < sentinel-pg16.dump > /dev/null && echo "dump is readable"

docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' > counts-pg16.txt <<'SQL'
SELECT table_name || ' ' || (xpath('/row/c/text()',
    query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY 1;
SQL

cp .env env.pg16.backup
```

Copy `sentinel-pg16.dump`, `counts-pg16.txt` and `env.pg16.backup` somewhere
safe (the dump contains password hashes and agent token hashes, see
[Backups](#backups)). Do not continue until the dump is readable and the count
file is not empty.

**2. Start an empty PostgreSQL 18 database on a new volume**

Stop the stack without `--volumes`, select PostgreSQL 18 and authorize it to
create the empty database it will be restored into:

```bash
docker compose down                # never add --volumes here
cat >> .env <<'EOF'
SENTINEL_POSTGRES=18
SENTINEL_POSTGRES_INITIALIZE=true
EOF

scripts/postgres-preflight.sh --migrate    # expected: migration authorised
docker compose up -d --wait db     # only the database, not the application
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW data_directory"'
# expected: /var/lib/postgresql/18/docker
```

Do not start `web` yet: it would create the tables the restore is about to
create.

**3. Restore and verify**

```bash
docker compose exec -T db sh -c \
    'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --single-transaction --exit-on-error' \
    < sentinel-pg16.dump
docker compose exec -T db sh -c 'vacuumdb -U "$POSTGRES_USER" -d "$POSTGRES_DB" --analyze-only'

docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' > counts-pg18.txt <<'SQL'
SELECT table_name || ' ' || (xpath('/row/c/text()',
    query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY 1;
SQL
diff counts-pg16.txt counts-pg18.txt && echo "row counts are identical"
```

The restore runs in one transaction and stops at the first error, so a failure
leaves the new database empty. Statistics are not part of a dump, hence the
`vacuumdb --analyze-only`.

**4. Start the application and check it**

The database exists now, so take the authorization back (the `db` container is
recreated once) and confirm the database to start; both volumes exist, so the
preflight asks for the confirmation:

```bash
sed -i.bak '/^SENTINEL_POSTGRES_INITIALIZE=/d' .env && rm .env.bak
scripts/postgres-preflight.sh --confirm 18
docker compose up -d --wait
docker compose exec web python manage.py migrate --check
curl -fsS http://127.0.0.1:8000/health/ready/
```

Sign in to the console and the admin, and confirm that servers, their history
and the network targets are there and that agents report again.

**Rollback**

While the PostgreSQL 16 volume (`<project>_postgres_data`, see
`docker volume ls`) exists, the previous state is one step away:

```bash
docker compose down
cp env.pg16.backup .env            # without the SENTINEL_POSTGRES line
scripts/postgres-preflight.sh --confirm 16
docker compose up -d
```

This starts PostgreSQL 16 on its original volume, exactly as it was when the
application was stopped in step 1. Anything the PostgreSQL 18 database
accepted after that point is not in it: a PostgreSQL 18 dump cannot be
reliably restored into PostgreSQL 16, so decide within the verification
period. If the restore itself failed, the same rollback applies and nothing
has been lost.

**Afterwards**

Keep the PostgreSQL 16 volume and the dump for as long as you want a way back,
for example until backups of the new database have been taken and restored
successfully on a test host. Remove the old volume only then, by hand
(`docker volume rm <project>_postgres_data`); nothing in this repository
deletes it. Until it is gone both volumes exist and the preflight needs
`--confirm 18` on every run; afterwards it recognises the installation by
itself. From now on keep `SENTINEL_POSTGRES=18` in `.env`: removing it points
the service back at the PostgreSQL 16 volume, and with both volumes present
nothing but the preflight would stop `docker compose up` from starting it.

### Retention

Run the purge commands daily (see "Data retention and history" in the
README):

```bash
docker compose exec -T web python manage.py purge_network_measurements
docker compose exec -T web python manage.py purge_absent_docker_containers
docker compose exec -T web python manage.py purge_snmp_data
docker compose exec -T web python manage.py purge_telemetry_samples
docker compose exec -T web python manage.py clearsessions
```

`clearsessions` removes expired web sessions (every console sign-in creates one).
If the server is on the internet, rate-limit `POST /api/v1/console/auth/login/`
in the front end (Cloudflare rate limiting rules or WAF) and do not exempt
`/api/v1/console/` from the protections you apply to `/admin/`: the in-app
sign-in throttle limits password guessing per account, not the load a flood of
attempts puts on the server.

### Resources

The defaults suit small installations (two Gunicorn workers, about 60 MB
each). Set `WEB_CONCURRENCY` in `.env` for more workers. To cap memory, add a
`deploy.resources.limits.memory` entry to the services in a
`compose.override.yml`.

Secret rotation, troubleshooting and known limitations:
[operations.md](operations.md) and [security.md](security.md).
