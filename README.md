# SSphere Sentinel

Self-hosted infrastructure and network monitoring with a central Django server
and lightweight host agents.

> **Status:** early development. Interfaces and data contracts may still change.
> The browser console is under active development and clearly labels sample or
> unconnected data; see the [frontend guide](frontend/README.md). Alerting
> covers health incidents, with optional email notifications; metric threshold
> alerts, other notification channels, SLA reporting, and remote target
> configuration are not implemented.

## What it monitors

- Server liveness, CPU, memory, disk, and uptime.
- Docker container state and health (optional).
- ICMP and TCP reachability, latency, and packet loss.
- SNMPv2c and SNMPv3 device reachability, system information, interfaces, and
  counters (optional).

The server stores current state and bounded history in PostgreSQL. Operators
manage inventory and agents in Django admin; the web console, served on the
same address by the Compose deployment, reads the session-authenticated console
API.

## Architecture

![SSphere Sentinel architecture](docs/assets/architecture.webp)

Sentinel has two independently packaged parts:

- **Server (`ssphere-sentinel`)** — Django, Gunicorn, and PostgreSQL. It accepts
  agent heartbeats at `POST /api/v1/agent/heartbeat/`, exposes the console API
  below `/api/v1/console/` (reads, and the administration a permission allows),
  and provides Django admin. In the Compose deployment an nginx `proxy` service
  serves the built web console and passes these paths on to Django, on one
  address ([server deployment](docs/server-deployment.md)).
- **Agent (`ssphere-sentinel-agent`)** — a Python 3.11+ process for Linux or
  macOS. It has no Django dependency and does not require Docker. The agent
  always initiates connections to the server.

![SSphere Sentinel agent workflow](docs/assets/agent-workflow.webp)

Host telemetry and Docker state travel with heartbeats. Network checks and SNMP
polls run independently, enter a local SQLite queue first, and leave it only
after the server acknowledges them. A server outage therefore does not discard
queued measurements, subject to the configured age and size limits.

## Documentation

| Audience | Document |
| --- | --- |
| Contributors and local development | This README |
| Production server operators: installation (one command: `curl -fsSL https://github.com/alxgls21/ssphere-sentinel/releases/latest/download/install.sh \| sudo bash`), HTTPS, upgrades, migrations, backup and restore, PostgreSQL recovery | [Server deployment](docs/server-deployment.md) |
| Agent operators: hardened systemd installation, Docker/SNMP enablement, upgrades, token rotation, troubleshooting | [Agent deployment](docs/agent-deployment.md) |
| SNMP operators and integrators: configuration, credential rules, payload contract, retention | [SNMP monitoring](docs/snmp.md) |
| Security reviewers and operators: trust boundaries, access control, hardening, limitations | [Security model](docs/security.md) |
| Secret rotation and current troubleshooting notes | [Operations](docs/operations.md) |
| Frontend contributors | [Frontend guide](frontend/README.md) |

The executable configuration reference is [`.env.example`](.env.example). Do
not copy settings from prose without checking that file and the deployment guide
for the release being installed.

## Requirements

- Server: Python 3.12+ and PostgreSQL 16+ (PostgreSQL 18 for new Compose
  installations).
- Agent: Python 3.11+ and `psutil`; Docker and SNMP support are optional extras.
- `pip` and a Python virtual environment.
- Docker Engine 24+ and Docker Compose 2.24+ only for the Compose deployment.
- Node.js and npm for frontend development; see the
  [frontend guide](frontend/README.md).

## Local development

Docker is optional for this workflow. PostgreSQL is not: SQLite is unsupported.

### 1. Create the environment

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e . -e ./agent

cp .env.example .env
```

In `.env`, replace `DJANGO_SECRET_KEY`, `AGENT_TOKEN_PEPPER`, and
`POSTGRES_PASSWORD`, set `DJANGO_DEBUG=true`, and keep
`POSTGRES_HOST=localhost` for a native PostgreSQL server. Never commit `.env`.

The repository contains two Python distributions:

| Distribution | Source | Optional extras |
| --- | --- | --- |
| `ssphere-sentinel` | `pyproject.toml`, packages `sentinel` and `apps` | none |
| `ssphere-sentinel-agent` | `agent/pyproject.toml`, package `agent` | `docker`, `snmp` |

For both agent extras, use `pip install -e './agent[docker,snmp]'` instead of the
plain agent install above.

### 2. Prepare PostgreSQL

Create a local role and database matching `POSTGRES_USER`, `POSTGRES_PASSWORD`,
and `POSTGRES_DB` in `.env`, then load the environment:

```bash
createuser sentinel
createdb -O sentinel sentinel
psql -d postgres -c "ALTER USER sentinel WITH PASSWORD 'your-password';"

set -a && source .env && set +a
python manage.py migrate
```

Grant the development role `CREATEDB` only if Django's test runner should create
`test_<database>` automatically.

### 3. Run the applications

```bash
python manage.py runserver
python manage.py run_alert_engine    # incidents; in a second terminal
```

Useful endpoints:

- `http://127.0.0.1:8000/health/` — process liveness.
- `http://127.0.0.1:8000/health/ready/` — database readiness.
- `http://127.0.0.1:8000/admin/` — Django admin.

For development, run the frontend's dev server against this backend as
described in [`frontend/README.md`](frontend/README.md); the Compose deployment
builds the console and serves it itself. Its documentation states which views
use live backend data and which still use labelled sample data.

### 4. Run the checks

```bash
# Django applications
python manage.py test apps

# Standalone agent
python -m unittest discover -s agent/tests -t . -v

# Packaging and deployment files
python -m unittest discover -s tests -t . -v

# Django configuration
python manage.py check
python manage.py check --deploy
```

Some Django integration tests invoke the agent, so install both editable
distributions. `SENTINEL_TEST_BUILD=1` also builds and installs the wheels during
the packaging checks and may need network access.

## Configuration

All runtime configuration comes from environment variables. The main groups
are:

| Area | Settings or reference |
| --- | --- |
| The installation's address (hosts, sign-in origin, cookies, email links) | `SENTINEL_URL`; see [server deployment](docs/server-deployment.md#settings) |
| Django, cookies, hosts, logging | `DJANGO_*` in [`.env.example`](.env.example) |
| PostgreSQL connection and Compose version selection | `POSTGRES_*`, `SENTINEL_POSTGRES*`; see [server deployment](docs/server-deployment.md#postgresql-versions) |
| Liveness and history retention | `SENTINEL_OFFLINE_THRESHOLD`, `SENTINEL_*_RETENTION_*`, and `SENTINEL_*_MAX_AGE_*` |
| Console sessions and thresholds | `SENTINEL_CONSOLE_*` and `SENTINEL_THRESHOLD_*` |
| Agent URL, token, intervals, and local files | [`deploy/systemd/agent.env.example`](deploy/systemd/agent.env.example) |
| SNMP devices, credentials, and queue limits | [SNMP configuration](docs/snmp.md#configuration) |
| Incident emails (optional SMTP) | `SENTINEL_SMTP_*`, `SENTINEL_EMAIL_FROM`, `SENTINEL_CONSOLE_URL`; see [alerts and email](docs/server-deployment.md#alerts-and-email-notifications) |

Production deployments must use HTTPS. Agent tokens are bearer credentials;
they must not appear in URLs, logs, or committed files. See the
[security model](docs/security.md) before exposing Sentinel to a network.

## Running an agent locally

Create a Server and Agent in Django admin, or create the agent from the command
line:

```bash
python manage.py create_agent --server SERVER_UUID --name server-agent
```

The raw token is shown once. Configure the local process and send either one
heartbeat or continuous heartbeats:

```bash
export SENTINEL_URL=http://127.0.0.1:8000
export SENTINEL_AGENT_TOKEN='paste-token-here'

sentinel-agent heartbeat
sentinel-agent run
```

The default heartbeat interval is 30 seconds. `sentinel-agent run` remains in
the foreground, logs to stderr, and exits cleanly on `SIGINT` or `SIGTERM`.
Use the [systemd deployment guide](docs/agent-deployment.md) on monitored Linux
hosts.

For network monitoring, create and assign Network targets in Django admin, then
copy [`agent/network_targets.example.json`](agent/network_targets.example.json)
and set `SENTINEL_NETWORK_TARGETS_FILE` to its absolute path. Target IDs in the
file must match the assigned database records. ICMP requires the narrow
unprivileged-ping setup described in the agent deployment guide; TCP probes do
not.

### Docker discovery (v0.1, optional)

Install the agent with its `docker` extra and grant access to a Docker API. The
agent reads container identity, image, state, health, and timestamps; it never
reads environment variables, secrets, mounts, command lines, or logs, and never
performs Docker control actions.

Access to the Docker socket is normally root-equivalent. Prefer the read-only
socket proxy in the [agent deployment guide](docs/agent-deployment.md#docker-monitoring-optional).

## Agent API contract

Agents authenticate with `Authorization: Bearer <token>` and send JSON to
`POST /api/v1/agent/heartbeat/`. The server stores only a peppered hash of each
token. The request may omit every optional monitoring section and still update
liveness.

| Section | Version | Main fields | Persistence |
| --- | --- | --- | --- |
| `telemetry` | 1 | `collected_at`, CPU and memory percentages, memory/disk byte counts, disk percentage, uptime | Latest snapshot plus rate-limited history |
| `docker` | 1 | availability, collection time, container ID/name/image/state/health/timestamps | Latest authoritative inventory only |
| `network` | 1 | measurements with stable `measurement_id`, target, time, success, latency/loss, probe counts, failure reason | Idempotent history |
| `snmp` | 1 | polls and interface samples | Idempotent history; full contract in [SNMP monitoring](docs/snmp.md#the-snmp-heartbeat-section-version-1) |

Important contract rules:

- One request is at most 2,500,000 bytes; production proxies should allow at
  least 3 MB.
- Network measurements and SNMP polls are acknowledged individually. Created or
  duplicate items leave the local queue; retryable or unacknowledged items stay.
- Invalid optional sections do not undo an authenticated heartbeat or other
  valid sections. The response identifies accepted, partial, rejected, ignored,
  or duplicate work as applicable.
- Agent timestamps may arrive out of order. Latest-state records only move
  forward, while stable measurement and poll IDs make history retries
  idempotent.
- Queue overflow drops the oldest entries and logs the loss. The defaults are
  10,000 network measurements, 10,000 SNMP polls, and seven days.

Exact validation and acknowledgement rules for SNMP are intentionally kept in
one place: [docs/snmp.md](docs/snmp.md). The shipped JSON examples are the
starting point for network and SNMP configuration.

## Console API contract

The browser console uses Django sessions and CSRF protection, never agent
tokens. Besides sign-in and sign-out it writes only what an account is
permitted to administer (acknowledging incidents, alert rules, its own email
preferences, test emails), every change checked on the server. Access is
deny-by-default and filtered by customer/site grants; see
[console access control](docs/security.md#console-authentication-and-access-control).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/console/session/` | Current session, CSRF token, and UI thresholds |
| `POST /api/v1/console/auth/login/` | Session sign-in |
| `POST /api/v1/console/auth/logout/` | Session sign-out |
| `GET /api/v1/console/scope/` | Visible customers and sites |
| `GET /api/v1/console/servers/` | Filtered, sorted, paginated servers and status counts |
| `GET /api/v1/console/servers/<id>/` | One visible server and its containers |
| `GET /api/v1/console/servers/<id>/series/` | CPU, memory, and disk series for `15m`, `1h`, `6h`, or `24h` |
| `GET /api/v1/console/containers/` | Filtered, sorted, paginated containers |
| `GET`, `POST /api/v1/console/alert-rules/`; `GET`, `PATCH /api/v1/console/alert-rules/<id>/`; `GET /api/v1/console/alert-rules/options/` | Alert rules: list, create, change (with the `version` read), and the valid conditions |
| `GET`, `PUT /api/v1/console/settings/notifications/me/` | The signed-in user's own email preferences |
| `POST /api/v1/console/settings/notifications/test-email/`; `GET .../test-email/<id>/` | A test email to the user's own address, sent by the notifier |
| `GET /api/v1/console/system/status/` | Alert engine, notifier, email outbox, and the settings the environment sets |
| `GET`, `POST /api/v1/console/domains/`; `GET /api/v1/console/domains/<id>/` | Monitored domains: list, add, and the TXT record that verifies one |
| `POST /api/v1/console/domains/<id>/verify/`; `GET .../verifications/<id>/` | A domain verification, answered by the domain verifier from the domain's name servers |

Server lists accept `customer`, `site`, `q`, `status`, `sort`, `dir`, `page`,
and `pageSize`; container lists also accept `server`. The implementation owns
the exact allowed status and sort values, and the frontend API adapter maps the
responses into UI view-models.

Unknown parameters, repeated parameters, invalid ranges, and unsupported sort or
filter values return `400`. A hidden object is indistinguishable from one that
does not exist. List endpoints return no more than 200 rows per page.

Liveness is derived from the server's last heartbeat and
`SENTINEL_OFFLINE_THRESHOLD` (90 seconds by default). A stale telemetry snapshot
is retained as the last known reading and returned with `stale: true`, but it is
excluded from current health, counts, and resource sorting. Container state also
becomes unknown when its host or Docker report is no longer current. A container
its host no longer lists (removed, or its stack taken down) leaves the console
with the next Docker report; its row stays in the database for
`SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS` until
`purge_absent_docker_containers` deletes it.

## Data retention and history

History is bounded by settings in [`.env.example`](.env.example). Cleanup is
explicit and must be scheduled; it does not run during heartbeats.

```bash
python manage.py purge_network_measurements
python manage.py purge_absent_docker_containers
python manage.py purge_snmp_data
python manage.py purge_telemetry_samples
python manage.py purge_incidents
python manage.py purge_notifications
python manage.py clearsessions
```

Ended incidents are kept for `SENTINEL_INCIDENT_RETENTION_DAYS` with their
history; open ones, and those with an email still to be sent, are never removed.
The record of each email is kept for `SENTINEL_NOTIFICATION_RETENTION_DAYS`
(and goes with its incident if that is sooner); an email not sent within
`SENTINEL_NOTIFICATION_MAX_AGE_HOURS` is given up.

Every purge command supports bounded batches; the Sentinel commands also support
`--dry-run`. With Compose, run them through
`docker compose exec -T web python manage.py ...`. The
[server deployment guide](docs/server-deployment.md#retention) contains the
production command set and scheduling context.

Do not interpret missing history as downtime. A stored failed probe means the
target was unreachable; missing samples may instead mean the agent was offline,
the probe could not run, data is still queued, or retention removed it.

## Deployment, backup, and recovery

Use [docs/server-deployment.md](docs/server-deployment.md) for production. It is
the source of truth for:

- TLS termination and reverse-proxy request limits.
- Safe upgrades and database migrations.
- PostgreSQL backup, restore, major-version migration, rollback, and volume
  preflight checks.
- Retention jobs and resource sizing.

Before every upgrade, take and test a database backup. Never use
`docker compose down --volumes` for a normal upgrade: it deletes the database
volume. Run `scripts/postgres-preflight.sh` before starting a Compose database
after any version or volume change. See [Operations](docs/operations.md) for
secret rotation and symptom-based recovery, and [Security](docs/security.md)
for deployment warnings that must not be relaxed for convenience.

## Releases

A release is a tag `vX.Y.Z` (or `vX.Y.Z-rc.N` for a pre-release) on `main`,
after the version in `pyproject.toml` and `agent/__init__.py` has been set to
`X.Y.Z` in a commit. Pushing the tag starts
[`.github/workflows/release.yml`](.github/workflows/release.yml): the whole CI
on the tagged commit, then the server and proxy images on the GitHub Container
Registry (linux/amd64, with an SBOM and a provenance attestation), then the
installation bundle installed by the release's own `scripts/install.sh` on a
clean runner and checked, and only then the GitHub Release with the bundle,
`install.sh` and `SHA256SUMS`. A stable
release also moves the images' `X.Y` and `latest` tags; a pre-release does not.
A release that fails part-way publishes no release and moves no tag (images
it already pushed keep only their version tag): fix the cause and tag the next
patch version.

The first release creates the two packages on GitHub as private: make them
public once, in each package's settings (*Package settings → Change
visibility*), so that servers can pull them without signing in.

## Project layout

```text
apps/                  Django applications and APIs
agent/                 Standalone agent distribution
sentinel/              Django project settings and URL routing
frontend/              Browser console
deploy/                Compose fragments and systemd assets
docs/                  Operator and security guides
requirements/          Hash-pinned server dependencies
scripts/               Maintenance and deployment helpers
tests/                 Packaging and deployment-file checks
```

## License

SSphere Sentinel is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0).

Copyright © 2026 Alexandros Goulas.
