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
docker compose ps                     # db and web "healthy"
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

Before `web`, every `docker compose up` runs the one-shot `migrate` service,
which exits with status 0: in the default configuration it has nothing to do,
because `web` applies the migrations itself (`docker compose ps --all` lists it
as exited).

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

### Request body size

A heartbeat is one JSON request. It takes a few kilobytes without SNMP, and an
agent that polls SNMP devices or watches many containers sends more, up to
**2,500,000 bytes**: the agent counts each request in the bytes it sends and
never goes above that. Everything between the agent and Sentinel must accept
bodies of at least that size; 3 MB leaves room.

- **Sentinel.** Django refuses a body over `DATA_UPLOAD_MAX_MEMORY_SIZE`, 2,621,440
  bytes (2.5 MiB), its default, with HTTP 400. Sentinel does not change it.
  Gunicorn does not limit the body.
- **The front end** may refuse less, and it does so before Sentinel sees the
  request: nothing is recorded, not even that the agent is alive.

| Front end | Default | What to set |
| --- | --- | --- |
| nginx | `client_max_body_size 1m`: a larger body gets `413 Request Entity Too Large` | `client_max_body_size 3m;` in the `server` or `location` that proxies Sentinel |
| Apache httpd | `LimitRequestBody`: 1 GiB in Apache 2.4 (0, no limit, in versions up to 2.4.53) | if you set one, at least `3145728` |
| Caddy | no limit | if you set one with `request_body { max_size ... }`, at least `3MB` |
| Traefik | no limit | if you use the `buffering` middleware, `maxRequestBodyBytes` of at least `3000000` |
| Cloudflare (Tunnel or proxy) | 100 MB on the Free and Pro plans, far above | a WAF or custom rule that limits the body size must allow 3 MB |

Other proxies, API gateways, load balancers and WAFs have limits of their own;
check them. To test the path, send a body of 2.4 MB without a token. A front end
that accepts it lets the request through to Sentinel, which answers `401`; one
that refuses it answers `413` (or `400`):

```bash
python3 -c 'print("{\"pad\": \"" + "x" * 2_400_000 + "\"}")' | curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data-binary @- https://sentinel.example.com/api/v1/agent/heartbeat/
```

An agent whose heartbeat is refused as too large logs `HTTP 413 (request body N
bytes)` or `HTTP 400 (request body N bytes)`, and keeps its queued data
([snmp.md](snmp.md#request-size)).

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
   git diff <current-tag> <new-tag> -- .env.example compose.yml deploy/ entrypoint.sh
   ```

3. Deploy:

   ```bash
   git checkout <new-tag>
   scripts/postgres-preflight.sh
   docker compose up -d --build
   docker compose ps
   ```

Migrations run automatically when the new `web` container starts. Scripts or
units that start the stack with `docker compose start` must use
`docker compose up -d` instead (see [Backups](#backups)).

To roll back, check out the previous tag and restore the backup taken before
the upgrade: migrations are not guaranteed to be reversible. Before checking
out a release without the `migrate` service, remove its exited container:

```bash
docker compose rm --stop --force migrate
git checkout <previous-tag>
docker compose up -d --build
```

Avoid `--remove-orphans` for this: without the same `-f` files the stack was
started with, it also removes the `cloudflared` container of
`compose.tunnel.yml`.

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

Applied automatically when the `web` container starts (the `migrate` service
has nothing to do in the default configuration). To inspect or run them by
hand:

```bash
docker compose exec web python manage.py showmigrations
docker compose run --rm web python manage.py migrate
```

Always back up first. Native installations run `python manage.py migrate`
with the production environment loaded. With
[separate database logins](#separate-database-logins) `web` cannot change the
schema: the `migrate` service applies them (`docker compose up -d`, or
`docker compose run --rm migrate apply-migrations`).

### Separate database logins

By default one PostgreSQL login does everything: the superuser the database
image creates, whose password `web` holds. With `SENTINEL_DB_ROLES=separate`
no Sentinel process holds a superuser's password or connects as one:

| Login | Used by | Can | Password in |
| --- | --- | --- | --- |
| `sentinel_app` | `web` | read and write the application's rows | `.env` (`SENTINEL_DB_PASSWORD`) |
| `sentinel_migrate` | `migrate` | change the schema, as `sentinel_owner` | `.env.migrate` (`SENTINEL_DB_MIGRATE_PASSWORD`) |
| bootstrap superuser | `db`, and the operator through `docker compose exec db` | everything | `.env.bootstrap` (`POSTGRES_PASSWORD`) |

Compose gives each password to its own service only. `.env` is the
environment of `web` and `migrate`, so it must not hold the other two:
`.env.migrate` is read by `migrate` alone, and `.env.bootstrap` by Compose
alone, to configure `db`. `migrate` does not get `SENTINEL_DB_PASSWORD` and
`web` does not get `SENTINEL_DB_MIGRATE_PASSWORD`, even when `.env` has them.
Every Sentinel process refuses to start with a password that is not its own,
and with `SENTINEL_DB_ROLES` unset or `legacy` while a password of the
separate logins is set. The provisioning of the logins needs the bootstrap
superuser and is the operator's: `scripts/postgres-roles.sh` runs it in the
`db` container, over its local socket, without the bootstrap password.

The separate logins are supported on a PostgreSQL cluster of Sentinel's own
only: the `db` service of this Compose project. PostgreSQL roles belong to the
whole cluster, so a shared or external cluster is not supported in this mode.
Provisioning, `scripts/postgres-roles.sh status` and every start refuse a
cluster that holds another database (besides Sentinel's, `postgres`,
`template0` and `template1`) or another role (besides the bootstrap
superuser, the three logins' roles and PostgreSQL's own `pg_` roles), and
name what they found. This is a compatibility check only: it says nothing
about how the cluster was created or what a superuser has done in it.

A start then goes: `db` healthy; `migrate` logs in (it cannot until the logins
are provisioned), checks the roles before it runs anything, applies the
migrations and checks the roles again. The checks are those of
`scripts/postgres-roles.sh status`, but the passwords (which only the
superuser may read), in a session PostgreSQL keeps read-only: what each role
may do, as PostgreSQL decides it, through `PUBLIC` and role memberships too,
grant options included, on every object of the application's database and of
what the cluster shares (databases, tablespaces, parameters); the system
catalogs only beyond what every role may read in them. Another database's objects cannot be seen from
this one, so the logins may not connect to any other database. `web` starts
only when that succeeded, checks the same again, and serves. Any failure
stops the start, with a message that names the database, the object, the
privilege and who holds it (`PUBLIC`, or a role), never a password; nothing
is revoked for you.

`django_migrations` records which migrations ran, and so decides the schema
changes `migrate` makes: `sentinel_app` may only read it. `migrate` creates it
in a transaction that also takes away the `INSERT`, `UPDATE` and `DELETE` the
owner's default privileges give every new table, so it is never committed
writable for `sentinel_app`. Should `sentinel_app` be able to write it
anyway, by a grant to it, to `PUBLIC`, on a column or through a role, neither
service starts and no migration runs, not even `manage.py migrate` run by
hand (it checks before anything else). Revoke it yourself, as
`scripts/postgres-roles.sh status` names it: `apply` changes nothing while
the roles differ from what it provisioned.

PostgreSQL itself must keep `sentinel_app` out of what it does not need: by
default every role may connect to every database, create temporary tables in
it and create large objects (`lo_creat`, `lo_create`, `lo_from_bytea`, and
psql's `\lo_import`, which calls them). Before the first provisioning, revoke
from `PUBLIC`, as the bootstrap superuser, `TEMPORARY` on every database,
`CONNECT` on every database but Sentinel's (`postgres` and `template1`), and,
in Sentinel's database, `EXECUTE` on those three functions (grant them back
to any other role of yours that needs them); `apply` refuses until then and
prints what is missing, and every start refuses should any of it come back.
Keep what `PUBLIC` held, to give it back should you not go on:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' > public-grants.sql <<'SQL'
SELECT format('GRANT %s ON DATABASE %I TO PUBLIC;', privilege, datname)
  FROM pg_database, unnest(ARRAY['CONNECT', 'TEMPORARY']) privilege
 WHERE datallowconn AND has_database_privilege('public', oid, privilege);
SELECT format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC;', oid::regprocedure)
  FROM pg_proc WHERE prosrc IN ('be_lo_creat', 'be_lo_create', 'be_lo_from_bytea')
   AND has_function_privilege('public', oid, 'EXECUTE');
SQL
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database WHERE datallowconn \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database WHERE datallowconn AND datname <> current_database() \gexec
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),
    pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;
SQL
```

Grants to `PUBLIC` elsewhere in Sentinel's database stop the start as well,
since they reach `sentinel_app` too: on another schema, its tables, views,
sequences or functions, on large objects, foreign-data wrappers and
servers, tablespaces and parameters, and on the system catalogs beyond what
initdb gave. Revoke them, or move what needs them to another database. Only
what initdb made counts as PostgreSQL's own: an object created later in
`pg_catalog` or `information_schema` is treated like any other, and nothing
created after initdb that runs code (a function, cast, operator, type,
extension and the like) may be in Sentinel's database at all, granted or
not; install such tools in another database. `apply` checks all of this
before it changes anything, and again at its end.

Revoking `CONNECT` keeps new sessions out of the other databases but ends
none: a session of `sentinel_app` or `sentinel_migrate` still open in one
stops the start, and `apply` and `status` refuse, naming each one (database,
pid, login, state) with the statement that would end it. Nothing ends it for
you. Find out what each is, then end it yourself, as the bootstrap
superuser, and run the check again:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT pid, usename, datname, state, backend_start, query
  FROM pg_stat_activity
 WHERE usename IN ('sentinel_app', 'sentinel_migrate') AND datname <> current_database();
SQL
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pg_terminate_backend(<pid>)"'
scripts/postgres-roles.sh status
```

`apply` reads what the cluster holds before it changes anything, and acts
on one of three states:

- **A, first activation:** none of the three roles and no record of an
  activation. `apply` creates the roles, their privileges and the record
  (schema `sentinel_restricted`, owned by the bootstrap superuser, open to no
  one, naming this database and the three roles), all at once.
- **B, activated:** the three roles and the record of their activation, as
  `apply` left them. `apply` checks everything first, then sets the
  passwords, and changes nothing else: run it again to rotate the passwords
  (new values in `.env` and `.env.migrate`), or with the same files to no
  effect.
- **C, anything else:** some of the roles only, roles without the record or
  the record without them, a record that names another database or other
  roles (a role dropped and created again, a database restored elsewhere), or
  in B anything that differs from what `apply` provisioned. `apply`,
  `scripts/postgres-roles.sh status` and every start refuse, name what they
  found, and change nothing; `apply` never takes over a role it did not
  create. Undo what differs by hand, in a maintenance window, as `status`
  names it; when roles or the record are missing, partial or another
  activation's, rebuild instead (the way back below).

`apply` is one transaction. When `scripts/postgres-roles.sh apply` does not
print `committed`, it says what happened: it refused, or stopped before its
`COMMIT`, and nothing changed (`nothing was committed`: still A, or B with the
old passwords); or the connection broke at its very end, after the `COMMIT`
(`the database is provisioned`). Running `apply` again, with the same files,
is safe in both cases.

#### A new installation

Follow [Configure](#1-configure), then give each login its own secret, with
the bootstrap password in its own file instead of `.env`:

```bash
secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(50))'; }
umask 077
printf 'POSTGRES_PASSWORD=%s\n' "$(secret)" > .env.bootstrap
printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$(secret)" > .env.migrate
sed -i.bak '/^POSTGRES_PASSWORD=/d' .env && rm .env.bak
cat >> .env <<EOF
SENTINEL_DB_ROLES=separate
SENTINEL_DB_PASSWORD=$(secret)
SENTINEL_BOOTSTRAP_ENV_FILE=.env.bootstrap
SENTINEL_MIGRATE_ENV_FILE=.env.migrate
EOF
```

Start the database alone, revoke temporary tables from `PUBLIC` (above),
provision the logins, then start everything:

```bash
scripts/postgres-preflight.sh
docker compose up -d --wait db
scripts/postgres-roles.sh apply       # expected: postgres-roles: apply: committed
docker compose up -d --build
docker compose ps --all               # migrate exited (0), db and web healthy
```

Continue with [Start](#2-start) from `createsuperuser`.

#### An existing installation

The tables of an existing installation belong to the bootstrap superuser;
`apply` hands them to `sentinel_owner` in the same transaction that creates
the logins. Plan a short maintenance window: `web` stays stopped from step 1
to step 4. Nothing here touches the database volume: never add `--volumes`
to a Compose command, and leave `SENTINEL_POSTGRES` in `.env` as it is (an
installation still on PostgreSQL 16 stays on it).

1. Back up the database (see [Backups](#backups)) and copy `.env`. Stop `web`
   (`apply` refuses while it is connected):

   ```bash
   cp .env env.legacy.backup
   docker compose stop web
   ```

2. Move the bootstrap password, unchanged, out of `.env` into
   `.env.bootstrap` (a different value would only recreate the `db` container;
   the superuser keeps the password it has), and add the two logins:

   ```bash
   secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(50))'; }
   umask 077
   grep '^POSTGRES_PASSWORD=' .env > .env.bootstrap
   printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$(secret)" > .env.migrate
   sed -i.bak '/^POSTGRES_PASSWORD=/d' .env && rm .env.bak
   cat >> .env <<EOF
   SENTINEL_DB_ROLES=separate
   SENTINEL_DB_PASSWORD=$(secret)
   SENTINEL_BOOTSTRAP_ENV_FILE=.env.bootstrap
   SENTINEL_MIGRATE_ENV_FILE=.env.migrate
   EOF
   ```

3. Keep and revoke what `PUBLIC` holds (above, `public-grants.sql`), then
   provision. The first `apply` refuses and lists the tables to hand over;
   run it again with them:

   ```bash
   scripts/postgres-roles.sh apply
   scripts/postgres-roles.sh apply --adopt-table <table> --adopt-table <table> ...
   ```

4. Start, and check:

   ```bash
   scripts/postgres-preflight.sh
   docker compose up -d
   docker compose ps --all            # migrate exited (0), db and web healthy
   scripts/postgres-roles.sh status   # expected: postgres-roles: status: verified
   curl -fsS http://127.0.0.1:8000/health/ready/
   ```

Going back, as long as nothing was committed (`apply` never printed
`committed`, and when it failed it said `nothing was committed`): restore
`env.legacy.backup` as `.env`, remove `.env.migrate` and `.env.bootstrap`,
give `PUBLIC` back what step 3 took, and start again:

```bash
cp env.legacy.backup .env
rm .env.migrate .env.bootstrap
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < public-grants.sql
scripts/postgres-preflight.sh
docker compose up -d
```

Should you be unsure whether it committed, ask the database (`f`: nothing was
committed, `t`: the logins are provisioned):

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'sentinel_restricted');
SQL
```

Once it has committed, the superuser login is refused for good in this
cluster: go on from step 4 (`apply` again first, if it was cut short). The way
back to one superuser login is then a new cluster, which
`sentinel/database.py` describes; the volume of this one stays as it is.
To move the data of an installation into a new, dedicated cluster of separate
logins, verified and without touching the old one, see
[Recover the data of an installation into a new cluster](#recover-the-data-of-an-installation-into-a-new-cluster).

#### Recover the data of an installation into a new cluster

To bring the data of an existing installation (one superuser login, or the
separate logins) into a new, dedicated cluster that is provisioned like
[a new installation](#a-new-installation), use `python3 -m sentinel.recovery`.
Only data crosses: roles, ownership, privileges and the schema of the old
database are never imported; the new cluster has the ones `apply` and the
`migrate` service made. The old database is never changed: its sessions are
read-only (`export` never writes, `verify-source` proves it), and the old
Compose project, its volume and its `.env` stay as they are. Nothing of the
new installation is published until every check has passed: from the first
change on, a record in the new database that only `sentinel_owner` can change
makes `web` and `migrate` refuse to start on it, however they are started,
until `activate` admits it.

The new cluster may be of the same or a newer PostgreSQL major version than
the old one (the dump is read by the new container's `pg_restore`), never an
older one. Both installations must run the same release: their migration
histories are compared as pairs `(app, name)`, whatever their ids, times and
order, and any difference is refused (update after the recovery).

**What each command does**

| Command | Runs on | Does |
| --- | --- | --- |
| `export` | the old installation | reads it (manifest, a data-only dump of schema `public` without `django_migrations`, the manifest again) into a private bundle directory |
| `verify-source` | the old installation | checks that it is still exactly what the bundle was made from; with `--work` it records the finding, which `activate` requires |
| `import` | the new installation, before `web` has ever run | checks, restores the data in one transaction as `sentinel_app` (no superuser, no `--disable-triggers`, foreign keys enforced), sets the sequences as `sentinel_owner` through `sentinel_migrate`, verifies; `--bundle-sha256` pins the bundle |
| `activate` | the new installation | refuses unless the import verified the destination, the bundle is the one imported and `verify-source` recorded the old database unchanged; checks the destination again (login, trust, migrations, tables and schema, every row, the sequences, no session of the application); only then runs `docker compose up --detach --wait` |

`import` stops at the first check that fails, names it, and rejects the
destination. The checks, in order:

| Check | Fails when |
| --- | --- |
| `bundle` | the dump is not the one exported (SHA-256), or the old database it was taken from is unsound (a row with no parent, a sequence behind its column or exhausted), has tables outside schema `public` or large objects |
| `destination.login` | the restore would run as a superuser, or not as `sentinel_app` |
| `destination.trusted` | the checks of every start of `web` (those of `scripts/postgres-roles.sh status`, but for the password verifiers) fail: the cluster is not Sentinel's own, or its roles, their record or their privileges differ from what `apply` left |
| `destination.idle` | any other session of `sentinel_app` or `sentinel_migrate` is connected (a session that is just ending is waited for, up to 3 seconds) |
| `destination.manifest` | the destination's database changed while it was read |
| `migrations` | the `(app, name)` pairs of the two `django_migrations` differ |
| `tables`, `schema` | the tables, columns, constraints or sequences differ, or a column is `GENERATED ALWAYS` |
| `destination.fresh` | the new database holds data of its own, or was emptied by an attempt that did not finish: a destination is used once |
| `dump.toc` | the dump is unreadable, or does not hold the data of exactly the application's tables and nothing else |
| `restore.clear`, `restore.data`, `restore.sequences` | the rows the migrations seeded could not be replaced; the restore failed (one transaction: it leaves none of the data); a sequence could not be set |
| `verify.data` | a table has other rows than the old one (count, and a fingerprint of every row) |
| `verify.integrity` | a foreign key has a row with no parent, or a constraint is not validated, or the schema moved |
| `verify.sequences` | a sequence would not give next what the old one would (`last_value` and `is_called` are read together: the value after the last one given, or the one to give if none was), or its next value is not beyond the largest in its column and within its maximum |
| `verify.trusted` | the destination is not as trusted as before, or the record of the migrations changed |

Every manifest reads each row once, to fingerprint it: `export` reads the old
database twice (before and after the dump), `import` reads the new one before
and after the restore, and `activate` once more. On a large database that is
minutes of reading on top of the dump and restore; measure it on a copy, and
size the maintenance window by it.

Exit status: `0` done; `1` rejected (a check failed) or refused (`activate`
lacks what it needs: nothing was started and the destination is not rejected
by it); `3` failed for another reason (a program could not run, a connection
broke, a directory exists, a record is malformed). The old installation is
never touched, by any status. Up to `dump.toc` a rejection leaves the
destination as it was: once the cause is fixed, `import` can be run again on it,
with a new `--work` directory. From `restore.clear` the destination is used,
and is made again.

**1. Prepare the new installation, while the old one runs**

Take the same release into a directory of its own (its Compose project, volume
and network take their names from it; set `COMPOSE_PROJECT_NAME` in its `.env`
should two directories share a name). `OLD` and `NEW` stand for the two
project directories:

```bash
OLD=/opt/ssphere-sentinel
NEW=/opt/ssphere-sentinel-new
git -C "$OLD" rev-parse HEAD                   # the release the old one runs
git clone https://github.com/alxgls21/ssphere-sentinel.git "$NEW"
git -C "$NEW" checkout "$(git -C "$OLD" rev-parse HEAD)"
cd "$NEW"
```

Configure it as in [1. Configure](#1-configure) (`SENTINEL_POSTGRES_INITIALIZE=true`
included) and give each login its own secret in `.env.bootstrap`, `.env` and
`.env.migrate` as in [A new installation](#a-new-installation): new secrets for
the database and its logins, but the same `DJANGO_SECRET_KEY`,
`AGENT_TOKEN_PEPPER` and application settings as the old `.env`, so that the
agents' tokens and the sessions keep working. Then provision, and migrate,
without starting `web`:

```bash
scripts/postgres-preflight.sh
docker compose build
docker compose up -d --wait db
# revoke from PUBLIC as above (keep public-grants.sql), then:
scripts/postgres-roles.sh apply          # expected: postgres-roles: apply: committed
docker compose run --rm migrate          # creates the tables, as sentinel_owner
scripts/postgres-roles.sh status         # expected: postgres-roles: status: verified
```

Never `docker compose up` the whole stack here: the application must not run
on the new database before the recovery has been verified (`destination.idle`).
Remove `SENTINEL_POSTGRES_INITIALIZE` from `.env` once the database exists.

**2. Maintenance window: stop the old application and export**

Agents keep queueing network measurements while the application is stopped
(see [operations.md](operations.md)). Stop `web` in the old project, so that
nothing writes to the old database, and read it into a private bundle:

```bash
docker compose --project-directory "$OLD" stop web
umask 077
python3 -m sentinel.recovery export --compose-dir "$OLD" --bundle /var/backups/sentinel-recovery/bundle
```

Expected: `recovery: exported to ...; the old database was read, never
written`, then the bundle's SHA-256 (note it: `import` can pin the bundle with
it, which matters if the bundle travels). If the export reports that the old database changed while it was
read, `web` was still running or something else wrote to it: stop it and run
`export` again (a failed export leaves no bundle). The bundle holds the data
of the old database, password hashes and agent token hashes included: keep it
private, as the dump of [Backups](#backups), and remove it once the recovery
is done. If the export says the old database is not sound, `import` will
refuse it; repair the data of the old installation and export again.

**3. Import and verify**

```bash
python3 -m sentinel.recovery import --compose-dir "$NEW" \
    --bundle /var/backups/sentinel-recovery/bundle --bundle-sha256 <sha256 export printed> \
    --work /var/backups/sentinel-recovery/work
```

Each check prints `recovery: <check>: passed`. On success the last line is
`recovery: VERIFIED: the destination holds exactly the data of the old
database; nothing is started until it is activated`, and `work/state.json`
says `verified`. The application has not run.

**4. Check the old one is unchanged, then activate**

Statistics are not part of a dump: collect them, then check that the old
database is still what was exported and start the new stack:

```bash
docker compose --project-directory "$NEW" exec -T db sh -c 'vacuumdb -U "$POSTGRES_USER" -d "$POSTGRES_DB" --analyze-only'
python3 -m sentinel.recovery verify-source --compose-dir "$OLD" \
    --bundle /var/backups/sentinel-recovery/bundle --work /var/backups/sentinel-recovery/work
python3 -m sentinel.recovery activate --compose-dir "$NEW" --work /var/backups/sentinel-recovery/work
curl -fsS http://127.0.0.1:8000/health/ready/
```

`verify-source` must say `the old database is exactly what was exported`, and
records it in the work directory: `activate` refuses to start anything without
it, so a restarted old `web` that took writes after the export cannot be
overlooked (export again, then). `activate` checks the destination again (the
login, trust, migrations, tables and schema, every row, the sequences and that
no session of the application is connected), refuses anything but a verified
work directory and the bundle that was imported, records `activating`, and
then starts the stack; `recovery: ACTIVATED` is the last line. Point the TLS front
end at the new project's port (the old `web` is stopped and its port free),
sign in to the console and the admin, confirm that servers, their history and
the network targets are there and that agents report again.

**If `activate` does not complete**

When it prints `docker compose up did not complete`, the stack may be partly
up and `web` may already be serving and writing: the work directory says
`activating`. Look at `docker compose --project-directory "$NEW" ps` and the
logs, fix the cause, and run `activate` again: it only starts the stack again,
without the checks. Never remove this destination's volume, nor `down
--volumes` in `$NEW`, once the application has run on it: the data it accepted
is in that database only. To go back instead, see Rollback.

**If a check fails**

The message names the check (`recovery: REJECTED: <check>: <what>`). The
destination is rejected and is not started, whatever the check, and the old
installation is as it was. Up to `dump.toc` nothing in the destination
changed: fix the cause and run `import` again, with a new `--work` directory.
From `restore.clear` it is used: make a new destination and run `import`
again with the same bundle (while the old database has not changed:
`verify-source`), a new `--work` directory, and a database that was not used:

```bash
cd "$NEW"
docker compose down --volumes            # only NEW: the old project is another directory
# then step 1 again: preflight, up -d --wait db, revoke from PUBLIC, apply, run --rm migrate
```

Never run `--volumes` in `$OLD`. A `restore.data` failure leaves none of the
data, since the restore is one transaction, but the rows the migrations seeded
are already replaced and a destination is used once; a killed `import` leaves
`state.json` at `restoring` and the same rule. A `bundle` rejection means exporting
again (a bundle that was altered, or an old database that is not sound).
When the two installations differ (`migrations`, `tables`, `schema`), start
the old one again (`docker compose --project-directory "$OLD" start web`), take
both to the same release, and start over.

**Rollback**

At any point until you have chosen to keep the new installation: stop the new
stack (`docker compose --project-directory "$NEW" down`, without `--volumes`)
and start the old one (`docker compose --project-directory "$OLD" start web`).
The old project, its database volume and its `.env` were never changed, so it
starts exactly as it was when it was stopped; whatever the new installation
accepted since then is not in it. Remove the old project's volume only once a
backup of the new database has been restored elsewhere and checked.

#### Operating it

* Management commands run in `web` (`docker compose exec web python manage.py
  ...`), with its login: the retention commands, `createsuperuser` and
  `clearsessions` need nothing more. Schema changes go through the `migrate`
  service.
* `manage.py dbshell` is disabled. Use psql in the `db` container.
* New passwords for the two logins: change them in `.env` and `.env.migrate`,
  stop `web`, run `scripts/postgres-roles.sh apply`, then `docker compose up -d`.
* Keep `.env.bootstrap` and `.env.migrate` private (`chmod 600`) and back them
  up with `.env`. Compose reads `.env.bootstrap` on every command, so it stays
  on the host; no Sentinel container receives it, but the `db` container's
  configuration (`docker inspect`) shows it, as it always has.

### Backups

`pg_dump` produces a consistent snapshot while the server runs:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    > "sentinel-$(date +%Y%m%d-%H%M%S).dump"
```

Restore into the existing database (stops the application meanwhile):

```bash
docker compose stop web
docker compose exec -T db sh -c \
    'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --single-transaction --exit-on-error' \
    < sentinel-<timestamp>.dump
scripts/postgres-preflight.sh
docker compose up -d
```

The restore is one transaction and stops at the first error: if it fails, it
changes nothing (the database is as it was before it began). Start the
application only when it ended without an error.

Use `docker compose up -d` to start the application again, not
`docker compose start web`: `start` waits for the exited `migrate` container,
and fails (older Compose releases wait indefinitely) when it no longer exists,
for example after `docker container prune`.

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
docker compose build
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
