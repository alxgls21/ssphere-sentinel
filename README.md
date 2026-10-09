# SSphere Sentinel

Self-hosted infrastructure monitoring and backup verification platform.

SSphere Sentinel will eventually monitor servers, Docker containers, services,
health checks, and backups. The repository currently provides the project
foundation: Django + PostgreSQL, agent registration/heartbeat API, and a
standalone host agent CLI.

## Status

**Early development / foundation only.**

Supported ways to run Sentinel:

1. **Native local development** with a Python virtual environment (recommended
   while hacking on the code). Docker is **optional**.
2. **Docker Compose** for easy self-hosting / deployment.
3. The standalone **`sentinel-agent`** CLI on monitored hosts — **does not
   require Docker**.

## Requirements

- **Python 3.12+**
- **PostgreSQL 16+** (local install for virtualenv development, or via Compose)
- **pip** / a virtual environment
- **Docker + Docker Compose** — only if you prefer the Compose stack

## Environment configuration

Copy the example file and set real secrets:

```bash
cp .env.example .env
```

Edit `.env` and replace at least:

- `DJANGO_SECRET_KEY`
- `AGENT_TOKEN_PEPPER`
- `POSTGRES_PASSWORD`

Never commit `.env`. All runtime configuration is loaded from environment
variables (see `.env.example`).

Load them into your shell before running Django management commands:

```bash
set -a && source .env && set +a
```

## PostgreSQL setup / configuration

PostgreSQL is the only supported database (including local development).
Do not switch to SQLite.

### Local PostgreSQL (virtualenv workflow)

1. Install and start PostgreSQL (Homebrew example):

   ```bash
   brew install postgresql@16
   brew services start postgresql@16
   ```

2. Create a role and database matching `.env` (example):

   ```bash
   createuser sentinel
   createdb -O sentinel sentinel
   psql -d postgres -c "ALTER USER sentinel WITH PASSWORD 'your-password';"
   ```

3. Set in `.env`:

   - `POSTGRES_HOST=localhost`
   - `POSTGRES_PORT=5432`
   - `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` accordingly

Grant the role permission to create databases if you want Django’s test runner
to create `test_<db>` automatically (`ALTER ROLE sentinel CREATEDB;`).

### Docker Compose PostgreSQL

Compose starts PostgreSQL 16 and always connects the `web` service with
`POSTGRES_HOST=db` (overrides `.env`). You only need a strong
`POSTGRES_PASSWORD` in `.env`.

## Local development with Python virtualenv

Docker is **not** required for this workflow.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

cp .env.example .env
# Edit secrets, keep POSTGRES_HOST=localhost for native Postgres

set -a && source .env && set +a
```

`pip install -e .` installs:

- Django project dependencies from `pyproject.toml`
- the `sentinel-agent` console script

### Running migrations

```bash
python manage.py migrate
```

### Running the Django development server

```bash
python manage.py runserver
```

Then open:

- Health: http://127.0.0.1:8000/health/
- Admin: http://127.0.0.1:8000/admin/

### Running tests

```bash
# Django apps
python manage.py test apps

# Standalone agent (no live Sentinel server required)
python -m unittest discover -s agent/tests -v

# System checks
python manage.py check
```

## Running the Sentinel agent locally

The host agent lives in the top-level `agent/` package. It does **not** import
Django and does **not** require Docker.

Create a server + agent token on the Django side first:

```bash
python manage.py create_agent --server <server-uuid> --name server-agent
```

Configure the agent:

```bash
export SENTINEL_URL=http://127.0.0.1:8000
export SENTINEL_AGENT_TOKEN=<token>
# optional; default is 30
export SENTINEL_HEARTBEAT_INTERVAL=30
```

### One-shot heartbeat

```bash
sentinel-agent heartbeat
```

Successful output:

```text
Heartbeat successful.
```

Example failure:

```text
Heartbeat failed: server returned HTTP 401.
```

### Continuous foreground run

```bash
sentinel-agent run
```

`sentinel-agent run`:

- stays in the **foreground** (does not daemonize)
- sends a heartbeat immediately, then every `SENTINEL_HEARTBEAT_INTERVAL`
  seconds (default **30**) on a fixed monotonic schedule; if one heartbeat
  takes longer than the interval, the missed slots are skipped (logged) rather
  than sent back-to-back
- logs failures and keeps running
- runs network probes independently of heartbeats (see
  [Network monitoring](#network-monitoring-v01))
- stops cleanly on SIGINT / SIGTERM

Production deployments will normally supervise this process with **systemd**
(or similar). A unit file is not shipped yet.

Use HTTPS for real deployments. The agent sends
`Authorization: Bearer <token>` and never puts the token in the URL.

Telemetry is collected with **psutil** (Linux and macOS) and sent in the same
agent cycle as the heartbeat — there is no separate metrics loop.

### Host telemetry (v0.1)

Each heartbeat/report cycle attempts to include a versioned telemetry object:

| Metric | Field | Unit |
| --- | --- | --- |
| CPU usage | `cpu_percent` | percent (0–100) |
| Memory total / used | `memory_total_bytes` / `memory_used_bytes` | bytes |
| Memory usage | `memory_percent` | percent (0–100) |
| Root disk total / used | `disk_total_bytes` / `disk_used_bytes` | bytes |
| Disk usage | `disk_percent` | percent (0–100) |
| Uptime | `uptime_seconds` | seconds |
| Collected at | `collected_at` | UTC ISO-8601 |

Payload version: **`telemetry.version = 1`**.

Example heartbeat body:

```json
{
  "telemetry": {
    "version": 1,
    "collected_at": "2026-10-07T12:00:00+00:00",
    "cpu_percent": 12.5,
    "memory_total_bytes": 17179869184,
    "memory_used_bytes": 8589934592,
    "memory_percent": 50.0,
    "disk_total_bytes": 494384795648,
    "disk_used_bytes": 220000000000,
    "disk_percent": 44.5,
    "uptime_seconds": 123456
  }
}
```

Empty / omitted telemetry remains valid (liveness-only), so older one-shot
clients keep working.

On the server, valid telemetry is stored as a **latest snapshot**
(`ServerTelemetry`, one row per server). This is **not** a historical
time-series store yet.

If telemetry collection fails on the agent, the failure is logged and a
liveness-only heartbeat is still sent. Invalid telemetry accepted by auth is
rejected for storage without overwriting the previous snapshot; liveness is
still updated.

Latest values are visible in Django admin (read-only). No dashboard UI yet.

### Docker discovery (v0.1, optional)

Docker monitoring is **optional**. Hosts without Docker, or agents that cannot
access the Docker daemon, continue normal heartbeat and host telemetry.

The agent uses the official Docker SDK (`docker` Python package) against the
Docker Engine API (typically the local Docker socket). It only **reads**
container state — it never starts, stops, restarts, or otherwise mutates
containers.

**Security warning:** Access to the Docker daemon/socket is highly privileged
and can be root-equivalent on many Linux systems. Grant the agent the minimum
access needed for read-only discovery, and treat the agent host as sensitive.

Collected per container:

| Field | Meaning |
| --- | --- |
| `container_id` | Full Docker ID (identity; not the mutable name) |
| `name` | Container name |
| `image` | Image reference |
| `state` | `running`, `exited`, `paused`, `restarting`, `created`, `dead`, `unknown` |
| `health` | `healthy`, `unhealthy`, `starting`, `none`, `unknown` |
| `created_at` / `started_at` | Timestamps when available |

Explicitly **not** collected: environment variables, secrets, mounts, labels,
command lines, logs, or full container configuration.

When Docker is unavailable, the agent still reports a machine-readable status
such as `unavailable`, `permission_denied`, or `error` with an empty container
list — the heartbeat itself does not fail.

Payload version: **`docker.version = 1`**.

Example fragment:

```json
{
  "docker": {
    "version": 1,
    "available": true,
    "status": "available",
    "collected_at": "2026-10-07T12:00:00+00:00",
    "containers": [
      {
        "container_id": "…",
        "name": "nginx",
        "image": "nginx:latest",
        "state": "running",
        "health": "healthy",
        "created_at": "…",
        "started_at": "…"
      }
    ]
  }
}
```

Server storage is **latest-state only** (`DockerHostState` + `DockerContainer`):

- Containers in a successful (`available`) discovery are upserted by
  `container_id` and marked `present=True`.
- Containers missing from that authoritative list are marked `present=False`
  (not hard-deleted).
- If discovery failed/unavailable, existing container rows are left unchanged
  (the agent did not obtain an authoritative list).

No Docker control/actions in this release. Inspect Docker state in Django admin.

### Network monitoring (v0.1)

The agent can probe configured network targets (ICMP echo and TCP connect)
and report latency, packet loss, and availability. Measurements are stored in
a local queue and delivered with the next heartbeats until the server
acknowledges them (see [Measurement queue and delivery](#measurement-queue-and-delivery)).

**Configuration is agent-local in v0.1** (not pushed from the server). Each
target `id` must match a `NetworkTarget` UUID in Django that is assigned to
the same agent.

1. Create `NetworkTarget` rows in Django admin (assigned agent, protocol/port).
   The UUID is generated on save; it is shown in the success message and as a
   read-only `ID` on the target's change page.
2. Put the same target UUID(s) in the agent-local JSON file:

   ```bash
   cp agent/network_targets.example.json /etc/ssphere/network_targets.json
   # edit ids/hosts to match admin targets
   export SENTINEL_NETWORK_TARGETS_FILE=/etc/ssphere/network_targets.json
   ```

Example target file:

```json
{
  "targets": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "public-dns-tcp",
      "hostname_or_ip": "1.1.1.1",
      "protocol": "tcp",
      "port": 443,
      "enabled": true,
      "monitoring_interval_seconds": 60,
      "timeout_seconds": 2,
      "probe_count": 4
    }
  ]
}
```

Heartbeat fragment (`network.version = 1`):

```json
{
  "network": {
    "version": 1,
    "measurements": [
      {
        "measurement_id": "…",
        "target_id": "11111111-1111-1111-1111-111111111111",
        "measured_at": "2026-10-08T12:00:00+00:00",
        "success": true,
        "latency_ms": 12.5,
        "packet_loss_percentage": 0.0,
        "probe_count": 4,
        "successful_probes": 4,
        "failure_reason": ""
      }
    ]
  }
}
```

Valid measurements are stored as **historical** `NetworkMeasurement` rows
(indexed by target / `measured_at`). Resending a `measurement_id` already
stored for the same agent is counted as an idempotent duplicate.

Each measurement is validated and stored **independently**. A problem with
the network section itself (not an object, unsupported version, more than 100
measurements) rejects the whole section as before. A problem with one
measurement (unknown/disabled/unassigned target, invalid fields, repeated
`measurement_id` within the report, `measurement_id` owned by another agent)
rejects only that measurement.

Heartbeat response fields for the network section:

| Field | Meaning |
| --- | --- |
| `network` | `accepted` (nothing rejected), `partial` (some stored, some rejected), or `rejected` |
| `network_created` | New rows stored |
| `network_duplicates` | Idempotent resends of already-stored measurements |
| `network_accepted` | `network_created + network_duplicates` |
| `network_rejected` | Number of rejected measurements |
| `network_rejections` | Present only when something was rejected: `[{"measurement_id": "…" or null, "reason": "…", "retryable": false}]` (`measurement_id` is null when it was not a valid UUID) |
| `network_results` | One entry per identifiable measurement in the report: `{"measurement_id": "…", "result": "created" \| "duplicate" \| "rejected"}`; rejected entries also carry `reason` and `retryable` |
| `network_detail` | Human-readable summary when anything was rejected |

`retryable: true` means the server could not store a valid measurement for a
transient reason and the agent should resend it; `false` means resending the
same measurement will never succeed. `network_results` and `retryable` are
additive fields; older agents ignore them.

Example partial response:

```json
{
  "status": "ok",
  "network": "partial",
  "network_created": 9,
  "network_duplicates": 0,
  "network_accepted": 9,
  "network_rejected": 1,
  "network_rejections": [
    {"measurement_id": "…", "reason": "target is disabled", "retryable": false}
  ],
  "network_results": [
    {"measurement_id": "…", "result": "created"},
    {"measurement_id": "…", "result": "rejected", "reason": "target is disabled", "retryable": false}
  ],
  "network_detail": "1 measurement(s) rejected; first: target is disabled"
}
```

The agent reads this response body: an HTTP 2xx only proves liveness was
recorded. Rejected or partial telemetry, Docker, and network results are
logged as warnings (server-provided reasons only, truncated; never the token
or the request payload).

#### Measurement queue and delivery

Every measurement gets a stable `measurement_id` and is written to a local
SQLite queue **before** it is sent. It leaves the queue only when the server
explicitly acknowledges it, so resends are idempotent duplicates rather than
new rows.

Configuration (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTINEL_QUEUE_PATH` | `$XDG_STATE_HOME/ssphere-sentinel/network-queue.sqlite3` (falls back to `~/.local/state/…`) | Queue file; must be an absolute path without `..` |
| `SENTINEL_QUEUE_MAX_MEASUREMENTS` | `10000` (100–1,000,000) | Maximum queued measurements |
| `SENTINEL_QUEUE_MAX_AGE_SECONDS` | `604800` (7 days; 3600–2,592,000) | Unsent measurements older than this are discarded |
| `SENTINEL_NETWORK_MAX_CONCURRENT_PROBES` | `4` (1–16) | Probe worker threads |

Invalid values are logged and replaced by the default. No queue file is
created unless at least one enabled network target is configured (or a queue
file already exists from an earlier run).

Storage and security:

- The queue directory is created with mode `0700`; it must be owned by the
  agent user (or root) and must not be group/other-writable. The queue file
  and its SQLite sidecar files are `0600`. Symlinked queue files are refused.
- Only the nine measurement fields shown above are stored (each payload is
  limited to 2 KiB). The agent token and server URL are never written to the
  queue or logged.
- Disk use is capped through SQLite's page limit, proportional to
  `SENTINEL_QUEUE_MAX_MEASUREMENTS`.

Retention and overflow: when the queue is full, the **oldest** measurements
are dropped to make room for new ones, with a warning. Measurements older than
`SENTINEL_QUEUE_MAX_AGE_SECONDS` are purged before each send.

Delivery and retry semantics (up to 100 measurements per heartbeat, oldest
first):

| Server response | Agent action |
| --- | --- |
| `created` / `duplicate` | Remove from queue |
| `rejected`, `retryable: false` | Remove from queue, log warning (never retried) |
| `rejected`, `retryable: true`, or measurement not mentioned | Keep; retry with per-measurement backoff (30 s doubling to 10 min), dropped with a warning after 10 attempts |
| Network error, timeout, non-2xx, invalid JSON, missing/unknown `network` status | Keep **all** measurements untouched; pause network sending with a batch backoff (30 s doubling to 10 min) while heartbeats continue |

Older servers without `network_results` are still supported: the agent
falls back to `network_rejections` plus the created/duplicate counts, and
treats anything it cannot attribute unambiguously as not yet delivered.

Scheduling:

- Each enabled target is probed every `monitoring_interval_seconds`
  (start-to-start) by a bounded worker pool. A slow target never overlaps
  itself and never delays heartbeats or other targets.
- Heartbeats are not blocked by probes, and heartbeat failures do not stop
  probing; queue failures are logged and never stop the agent.
- On SIGINT/SIGTERM the agent stops scheduling, cancels in-progress probes
  between attempts, and waits briefly for them; queued measurements are kept
  for the next start.
- `sentinel-agent heartbeat` (one-shot) probes all enabled targets once,
  enqueues the results, and sends the oldest pending measurements.

Operational limitations:

- If the queue location is unsafe or unusable, the agent logs a warning and
  uses an in-memory queue: measurements then do not survive a restart.
- A corrupted queue file is renamed to `<file>.corrupt-<timestamp>` and a new
  queue is started; the backlog in the corrupted file is not recovered.
- A queue file with a newer schema version (from a newer agent) is left
  untouched and the agent falls back to the in-memory queue.
- Large wall-clock jumps can make age-based retention discard or keep
  measurements earlier or later than expected; retry scheduling is protected
  against jumps backwards.
- Several agent processes sharing one queue file are safe (SQLite locking)
  but may send the same measurement twice; the server treats it as a duplicate.

In Django admin, a target's change page shows the latest measurement and a
link to that target's filtered measurement history (it no longer embeds the
history inline).

Retention defaults to 30 days:

```bash
# SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS=30
python manage.py purge_network_measurements
```

Network reports are isolated from liveness, host telemetry, and Docker: an
invalid network section does not block those subsystems.

**Security**

- Only probe destinations you are authorized to monitor.
- Targets come from the agent-local file, not from unauthenticated input.
- Hostnames/IPs are validated; probes never use `shell=True`.
- ICMP may require privileges / capabilities; if unavailable the agent reports
  `permission_denied` / `unsupported` and TCP targets continue to work.
- Root is not required for TCP monitoring.

SLA calculations, alarms, and remote target configuration are not implemented
yet.

## Server liveness / offline detection

Heartbeats update `Agent.last_seen_at`, `Server.last_seen_at`, and set stored
`Server.status` to `online`.

Current reachability is derived at read time from `last_seen_at` — no Celery
or periodic job is required:

| Condition | `Server.effective_status` |
| --- | --- |
| Never reported (`last_seen_at` is null) | `unknown` |
| Last seen within the threshold | `online` |
| Last seen older than the threshold | `offline` |

Configure the threshold on the server (seconds, default **90**):

```bash
# in .env / environment
SENTINEL_OFFLINE_THRESHOLD=90
```

With the default agent interval of 30s, 90s means roughly three missed
heartbeats before a server is considered offline. Stored `status` remains
available for future warning/error states; prefer `effective_status` for
liveness.

## Docker Compose deployment

Use Compose when you want a packaged self-hosted stack. It is optional for
day-to-day development.

```bash
cp .env.example .env
# Set DJANGO_SECRET_KEY, AGENT_TOKEN_PEPPER, POSTGRES_PASSWORD

docker compose up --build
```

Services:

- `web` — Django (Gunicorn); runs migrations on startup
- `db` — PostgreSQL 16

Verify:

```bash
curl http://localhost:8000/health/
```

Expected:

```json
{"status": "ok"}
```

## Agent authentication (server)

Agents authenticate with a Bearer token. Sentinel stores only an HMAC-SHA256
hash of the token (peppered with `AGENT_TOKEN_PEPPER`). The raw token is shown
once at creation and is never logged or persisted. Rotating
`AGENT_TOKEN_PEPPER` invalidates existing agent tokens; rotating
`DJANGO_SECRET_KEY` does not.

Admin can also regenerate a token via **Regenerate authentication token**.

Manual heartbeat with curl:

```bash
curl -X POST http://localhost:8000/api/v1/agent/heartbeat/ \
  -H "Authorization: Bearer <agent-token>" \
  -H "Content-Type: application/json"
```

## Project layout

```text
apps/                  Django applications
  core/                Health endpoint
  infrastructure/      Monitored servers, telemetry, Docker state
  agents/              Agent registration and heartbeat API
  network/             Network targets and measurement history
agent/                 Standalone host agent (no Django imports)
sentinel/              Django project settings and URL routing
manage.py
compose.yml
Dockerfile
pyproject.toml         Primary Python dependency definition
```

New Django apps belong under `apps/` and in `INSTALLED_APPS`.

## License

SSphere Sentinel is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

Copyright © 2026 Alexandros Goulas.
