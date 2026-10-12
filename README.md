# SSphere Sentinel

Self-hosted infrastructure and network monitoring platform.

SSphere Sentinel monitors servers through lightweight agents: server liveness
(heartbeats), host telemetry (CPU, memory, disk, uptime), Docker container
state, and ICMP/TCP network latency, packet loss and availability with
history. A Django + PostgreSQL server stores the data and shows it in the
Django admin; there is no separate dashboard, alerting or SLA reporting yet.

## Status

**Early development / foundation only.**

Supported ways to run Sentinel:

1. **Native local development** with a Python virtual environment (recommended
   while hacking on the code). Docker is **optional**.
2. **Docker Compose** for self-hosted production deployments
   ([docs/server-deployment.md](docs/server-deployment.md)).
3. The standalone **`sentinel-agent`** on monitored hosts, as a hardened
   systemd service ([docs/agent-deployment.md](docs/agent-deployment.md)) —
   **does not require Docker** or any server dependency.

## Architecture

![SSPHERE Sentinel Architecture](docs/assets/architecture.webp)

SSphere Sentinel has two parts:

- **Sentinel Server**: a central Django application with PostgreSQL. It
  receives agent heartbeats on one REST endpoint
  (`POST /api/v1/agent/heartbeat/`), stores server liveness, the latest host
  telemetry and Docker container state, and the history of network
  measurements, and presents them in the Django admin. Servers, agents and
  network targets are managed in the admin or with `manage.py` commands.
- **Sentinel Agent**: a lightweight, standalone Python program
  (`sentinel-agent`, no Django dependency) on each monitored Linux or macOS
  host.

Agents always initiate the connection; the server never connects to them.
Each agent authenticates with its own token (`Authorization: Bearer`; the
server stores only a hash of it) and uses HTTPS in production deployments.

The server and an agent can run on the same machine (for example
`SENTINEL_URL=http://127.0.0.1:8000`) or on separate hosts; one server
monitors many agents, one agent per monitored server. Deployment guides:
[server](docs/server-deployment.md) · [agent](docs/agent-deployment.md).

## How the Agent Works

![SSPHERE Sentinel Agent Workflow](docs/assets/agent-workflow.webp)

- **Heartbeat** every `SENTINEL_HEARTBEAT_INTERVAL` seconds (default 30). Each
  heartbeat carries the current [host telemetry](#host-telemetry-v01) (CPU,
  memory, disk, uptime, collected with psutil) and, when the Docker SDK is
  installed and the daemon is reachable, the [Docker discovery](#docker-discovery-v01-optional)
  result (container name, image, state and health; no resource usage).
- **Network checks** (ICMP ping and TCP connect) run on their own schedule,
  per target (default every 60 seconds), independently of heartbeats; see
  [Network monitoring](#network-monitoring-v01).
- **Local queue**: each network measurement is written to a local SQLite queue
  first and sent with the following heartbeats. It is removed only when the
  server acknowledges it (stored or permanently rejected). If the server is
  unreachable, measurements stay queued and are resent with backoff once it
  is back.
- **Limits**: only network measurements are queued; telemetry and Docker
  state are sent live, so a missed heartbeat simply has none. The queue is
  bounded (default 10,000 measurements and 7 days; the oldest are dropped
  first) and logs every drop. A measurement the server answers 10 times
  without storing it is also dropped; failed connections do not count as
  attempts. See [Measurement queue and delivery](#measurement-queue-and-delivery).

## Documentation

| Topic | Document |
| --- | --- |
| Production server (Docker Compose, Cloudflare Tunnel, reverse proxy, upgrades, backups, migrations) | [docs/server-deployment.md](docs/server-deployment.md) |
| Agent on Linux hosts (systemd, Docker monitoring, upgrades, troubleshooting) | [docs/agent-deployment.md](docs/agent-deployment.md) |
| Secret rotation and troubleshooting | [docs/operations.md](docs/operations.md) |
| Security model, trusted proxy boundary, known limitations | [docs/security.md](docs/security.md) |

## Requirements

- **Server:** Python 3.12+ and **PostgreSQL 16+** (local install for
  virtualenv development, or via Compose)
- **Agent:** Python 3.11+ on Linux or macOS; only depends on `psutil`
- **pip** / a virtual environment
- **Docker + Docker Compose** — only if you prefer the Compose stack

## Packaging

The repository contains two Python distributions:

| Distribution | Defined in | Contents | Dependencies |
| --- | --- | --- | --- |
| `ssphere-sentinel` (server) | `pyproject.toml` | `sentinel`, `apps` | Django 5.2, Gunicorn, psycopg, WhiteNoise |
| `ssphere-sentinel-agent` | `agent/pyproject.toml` | `agent`, `sentinel-agent` CLI | `psutil`; extra `[docker]` adds the Docker SDK |

The Docker image does not install the server distribution: it installs the
exact, hash-pinned dependency versions from `requirements/server.txt`
(regenerate with `python scripts/update_server_requirements.py`) and runs the
code from `/app`.

## Environment configuration

Copy the example file and set real secrets:

```bash
cp .env.example .env
```

Edit `.env` and replace at least:

- `DJANGO_SECRET_KEY`
- `AGENT_TOKEN_PEPPER`
- `POSTGRES_PASSWORD`

For local development also set `DJANGO_DEBUG=true` (the example file is
production-oriented: with `DJANGO_DEBUG=false`, cookies are HTTPS-only,
`runserver` does not serve the admin's static files, and the example secret
key is refused).

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
pip install -e . -e ./agent

cp .env.example .env
# Edit secrets, set DJANGO_DEBUG=true, keep POSTGRES_HOST=localhost for native Postgres

set -a && source .env && set +a
```

- `pip install -e .` installs the server and its dependencies.
- `pip install -e ./agent` installs the agent and the `sentinel-agent`
  console script (add `[docker]` for Docker discovery:
  `pip install -e "./agent[docker]"`).

Upgrading an existing virtualenv created before the server and agent were
split into separate distributions: run `pip uninstall -y ssphere-sentinel`
first, then the install command above. Otherwise pip removes the
`sentinel-agent` script while replacing the old combined package.

### Running migrations

```bash
python manage.py migrate
```

### Running the Django development server

```bash
python manage.py runserver
```

Then open:

- Health: http://127.0.0.1:8000/health/ (liveness) and
  http://127.0.0.1:8000/health/ready/ (database reachable)
- Admin: http://127.0.0.1:8000/admin/

### Running tests

```bash
# Django apps
python manage.py test apps

# Standalone agent (no live Sentinel server required)
python -m unittest discover -s agent/tests -t . -v

# Packaging and deployment-file checks (no Django or database needed);
# SENTINEL_TEST_BUILD=1 also builds and installs both wheels (network access)
python -m unittest discover -s tests -t . -v

# System checks, including production settings
python manage.py check
python manage.py check --deploy
```

GitHub Actions (`.github/workflows/ci.yml`) runs all of these on pull
requests and pushes to `main`: server tests against PostgreSQL on Python
3.12–3.14, agent tests on Python 3.11–3.14 (Linux, plus macOS) without any
server dependency installed, packaging and `pip-audit`/`bandit` checks, and
an end-to-end deployment (Docker image and Compose stack, then the agent
installed with the hardened systemd unit and verified against the server).

## Running the Sentinel agent locally

The host agent lives in the top-level `agent/` package and is its own
distribution (`ssphere-sentinel-agent`, see [Packaging](#packaging)). It does
**not** import Django and does **not** require Docker. For production hosts,
use the systemd service described in
[docs/agent-deployment.md](docs/agent-deployment.md).

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
# optional; DEBUG, INFO (default), WARNING or ERROR
export SENTINEL_LOG_LEVEL=INFO
```

`SENTINEL_URL` must not contain credentials (`https://user:pass@...` is
refused); the token is only ever sent in the `Authorization` header.

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
Heartbeat failed: server returned HTTP 401
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
- logs a startup summary (version, server URL, interval, network targets and
  queue location; never the token), then stays quiet while heartbeats
  succeed: successes are logged only at `DEBUG`, failures as warnings, and the
  first success after failures once at `INFO`
- runs network probes independently of heartbeats (see
  [Network monitoring](#network-monitoring-v01))
- stops cleanly on SIGINT / SIGTERM (`Received SIGTERM; stopping`,
  `Agent stopped`)

Logs go to stderr as `LEVEL: message`. Under systemd they carry journald
priorities, so `journalctl -u sentinel-agent -p warning` shows only problems.
A hardened unit file is shipped in `deploy/systemd/`
([docs/agent-deployment.md](docs/agent-deployment.md)).

Use HTTPS for real deployments. The agent sends
`Authorization: Bearer <token>` and never puts the token in the URL. It does
**not** follow HTTP redirects (which would forward the token to the redirect
target and turn the POST into a GET): a `3xx` response is a failed heartbeat,
so set `SENTINEL_URL` to the final `https://` address (for example when a
reverse proxy redirects HTTP to HTTPS).

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
still updated. Numbers must be finite (`NaN`/`Infinity` are rejected) and byte
counts must fit a signed 64-bit integer.

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
The systemd deployment does not grant Docker access by default; see
[Docker monitoring](docs/agent-deployment.md#docker-monitoring-optional) for a
read-only socket proxy and the opt-in `docker` group drop-in.

Discovery needs the Docker SDK: install the agent with the `[docker]` extra.
Without it Docker is reported as `unavailable` and the agent logs once that
Docker discovery is disabled; availability changes (for example
`permission_denied`) are logged once per change, not on every heartbeat.

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

- Containers in a successful (`available`) discovery are matched by
  `(server, container_id)` and marked `present=True`.
- Containers missing from that authoritative list are marked `present=False`
  (not hard-deleted). A container that reappears is marked present again.
- If discovery failed/unavailable, existing container rows are left unchanged
  (the agent did not obtain an authoritative list).
- Container rows are only written when something changes (new container,
  changed name/image/state/health/timestamps, appearance or disappearance).
  An unchanged container costs no database write.
- `DockerHostState.last_discovered_at` records the last successful discovery.
  Every present container was seen at that time; the admin "Last seen" column
  shows it. For absent containers `last_seen_at` is the last discovery that
  still listed them. (The stored `last_seen_at` of a *present* container is
  the time its row last changed.)
- Reports for the same server are serialized with a row lock on its
  `DockerHostState`, so concurrent heartbeats cannot interleave container
  updates; the last report to commit wins.

Long-absent containers are removed by a cleanup command (see
[Data retention and history](#data-retention-and-history)).

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

Measurements are kept for 30 days by default and purged by a scheduled
command; delayed measurements are accepted for up to 8 days (see
[Data retention and history](#data-retention-and-history)).

Network reports are isolated from liveness, host telemetry, and Docker: an
invalid network section does not block those subsystems.

**Security**

- Only probe destinations you are authorized to monitor.
- Targets come from the agent-local file, not from unauthenticated input.
- Hostnames/IPs are validated; probes never use `shell=True`.
- Root and capabilities are never required. ICMP uses `ping`, which needs
  either its `CAP_NET_RAW` file capability (blocked by the hardened systemd
  unit) or unprivileged ICMP sockets for the agent's group
  (`net.ipv4.ping_group_range`, disabled by default on Debian and Ubuntu; see
  [Allow ICMP probes](docs/agent-deployment.md#4-allow-icmp-probes)). If ICMP
  is not permitted the agent records `permission_denied` (`unsupported`
  without `ping`), logs the cause once, and TCP targets continue to work.

SLA calculations, alarms, and remote target configuration are not implemented
yet.

## Data retention and history

Configuration (server environment, all in days):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS` | `30` | Network measurements with `measured_at` older than this are purged |
| `SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS` | `8` | Oldest `measured_at` accepted from an agent (delayed delivery); never more than the retention period |
| `SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS` | `30` | Containers absent from successful discoveries for longer than this are deleted |

Cleanup commands (never run automatically, in particular not on heartbeats):

```bash
python manage.py purge_network_measurements      [--days N] [--batch-size N] [--dry-run]
python manage.py purge_absent_docker_containers  [--days N] [--batch-size N] [--dry-run]
```

Both delete in batches (default 5000 rows, max 100000) with one short
transaction per batch, so they do not hold long locks or create one huge
transaction, and an interrupted run keeps the batches already deleted.
`--dry-run` only counts. The cutoff is exclusive: a row exactly at the cutoff
is kept. Invalid options (`--days` ≤ 0, `--batch-size` out of range) exit with a
non-zero status and delete nothing, so cron or a systemd timer reports the
misconfiguration.

Docker cleanup only deletes rows with `present=False`. Containers only become
absent after a **successful** discovery that no longer lists them, so a Docker
outage, a permission problem, or an agent that stopped reporting never makes
containers eligible for deletion. A deleted container that comes back is
simply recreated as a new row.

### Scheduling the cleanup

Run the commands daily from cron or a systemd timer, as the same user and with
the same environment as the Django application.

cron (`crontab -e`):

```cron
# m h dom mon dow
15 3 * * * cd /opt/ssphere-sentinel && set -a && . ./.env && set +a && .venv/bin/python manage.py purge_network_measurements && .venv/bin/python manage.py purge_absent_docker_containers
```

systemd (`/etc/systemd/system/sentinel-retention.service` and `.timer`):

```ini
[Unit]
Description=SSphere Sentinel data retention

[Service]
Type=oneshot
User=sentinel
WorkingDirectory=/opt/ssphere-sentinel
EnvironmentFile=/opt/ssphere-sentinel/.env
ExecStart=/opt/ssphere-sentinel/.venv/bin/python manage.py purge_network_measurements
ExecStart=/opt/ssphere-sentinel/.venv/bin/python manage.py purge_absent_docker_containers
```

```ini
[Unit]
Description=Daily SSphere Sentinel data retention

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now sentinel-retention.timer
```

With Docker Compose, run the same commands through
`docker compose exec web python manage.py …` from the host's cron or timer.

### Delayed and out-of-range measurements

The agent queues measurements locally and may deliver them late (after a
server outage or network failure). The server accepts a measurement when its
`measured_at` is:

- no more than 5 minutes in the future (clock-skew allowance), and
- no older than `SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS` (capped at the
  retention period, since older rows would be purged immediately).

Out-of-range measurements are rejected individually with `retryable: false`
(`measured_at is too far in the future` / `measured_at is older than the
accepted history window`); the agent logs and drops them instead of retrying.
They are never dropped silently. Keep the agent's `SENTINEL_QUEUE_MAX_AGE_SECONDS`
(default 7 days) below the server window (default 8 days) so that delayed
measurements the agent still holds are accepted.

### Downtime vs. monitoring unavailable vs. missing data

These are different situations and must not be conflated (relevant for future
SLA reporting, which is not implemented yet):

- **Target down:** a stored measurement with `success=false` (and a
  `failure_reason` such as `timeout` or `connection_refused`). The agent was
  running and could not reach the target.
- **Monitoring unavailable:** a stored measurement whose `failure_reason` is
  `permission_denied` or `unsupported` says the probe itself could not run
  (for example ICMP without privileges); it is not evidence that the target
  was down. No measurements at all while the agent's server is offline (see
  liveness below) also means monitoring was unavailable.
- **Missing measurements:** gaps in the history with no stored rows. They can
  mean monitoring was unavailable, measurements were rejected or dropped (age
  window, agent queue limits), or are still queued on the agent and not yet
  delivered. A gap is "unknown", not "down".

### Agent deletion and historical data

- Deleting an **agent** (or the server it belongs to) keeps all network
  targets and measurements. Targets become unassigned (`assigned_agent`
  empty) and stop accepting reports until reassigned; measurements keep their
  target and lose the agent reference (`agent` empty).
- **Recreating** an agent: create a new agent, then assign the existing
  targets to it. Target UUIDs do not change, so the agent-local targets file
  stays valid. If the old agent's queue is resent, measurements already stored
  for the same target are acknowledged as duplicates; they keep their original
  (now empty) agent attribution.
- Deleting a **target** deliberately deletes its measurement history.
- Deleting an agent with a large history rewrites the `agent` column of all
  its measurements in one transaction. To retire an agent temporarily, prefer
  disabling it (`enabled=false`), which keeps everything unchanged.

### Guarantees and limitations

- A measurement is reported as `created` only after it has been stored, and
  the response is only sent after the database transaction commits. If the
  database fails, the heartbeat returns an error and the agent keeps the
  measurements queued.
- `measurement_id` is the idempotency key: resending stored measurements never
  creates duplicates, including under concurrent reports.
- History is only as complete as the agent queue allows (see the agent queue
  limits above) and as long as the retention period.
- There is no partitioning: the measurement table grows with
  targets × frequency × retention. Retention keeps it bounded.

## Ingest and admin performance

Measured on PostgreSQL 18 (statement counts per heartbeat request, including
authentication and liveness):

| Heartbeat | Before | After |
| --- | --- | --- |
| Heartbeat with host telemetry | 11 | 6 |
| Docker, 50 unchanged containers | 212 (50 rows rewritten) | 10 (no container writes) |
| Docker, 50 changed containers | 212 | 11 |
| Network, 100 new measurements | 308 | 12 |
| Network, 100 duplicates | 508 | 9 |

Docker containers are synchronized with one query for existing rows, one bulk
INSERT for new containers, bulk UPDATEs for changed ones and one UPDATE for
newly absent ones. Network measurements are checked for existing IDs in one
query and stored with one multi-row INSERT; only if that INSERT conflicts (for
example with a concurrent report) does the server fall back to per-row inserts
to classify each measurement exactly.

Admin changelists (servers, Docker containers, network targets, network
measurements) use a fixed number of queries regardless of the number of rows
shown, and the measurement list skips the extra full-table count.

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

## Inventory: customers, sites and devices

The Django admin has an **Inventory** section for organizing what is
monitored across several customers and locations:

| Model | Meaning |
| --- | --- |
| **Customer** | An organization whose networks are monitored |
| **Site** | A location of one customer (office, data center, branch) |
| **Device** | A network device (router, switch, firewall or other) with a management hostname or IP address, an optional site, and optionally the **agent** that can reach it |

Devices are inventory records only for now: nothing polls them yet. All three
have a UUID (shown read-only in the admin) so that later features can refer
to them.

Rules enforced on every save, in the admin and in code:

- Names are trimmed and must not be blank. They are unique ignoring case:
  customer names globally, site names per customer, device names per site
  (devices without a site are unique among themselves).
- A management address must be a hostname or a unicast IP address.
  Whitespace, shell or path characters, ports, URLs and mistyped addresses
  such as `256.1.1.1` are rejected. It does not have to be unique, because
  different customers often use the same private address ranges.
- Nothing is deleted implicitly: a customer that has sites, and a site that
  has devices, cannot be deleted until they are removed or moved. Deleting an
  agent only unassigns its devices.

Typical workflow: add the customer, add its sites (inline on the customer
page), then add devices and pick the site; assign an agent that can reach the
device's network. The device list can be filtered by customer, type, agent
and enabled state, and searched by name, address, site or customer.

## Docker Compose deployment

Use Compose for a self-hosted production stack; the full guide (HTTPS with
Cloudflare Tunnel or a reverse proxy, upgrades, backups, migrations) is
[docs/server-deployment.md](docs/server-deployment.md).

```bash
cp .env.example .env
# Set DJANGO_SECRET_KEY, AGENT_TOKEN_PEPPER, POSTGRES_PASSWORD,
# DJANGO_ALLOWED_HOSTS and DJANGO_CSRF_TRUSTED_ORIGINS

docker compose up -d --build
```

Services:

- `web` — Django on Gunicorn (2 workers, `WEB_CONCURRENCY`), non-root,
  read-only filesystem; waits for the database and runs migrations on start;
  serves the admin's static files itself (WhiteNoise)
- `db` — PostgreSQL 16, only reachable on the internal Compose network

Verify:

```bash
curl http://localhost:8000/health/        # liveness
curl http://localhost:8000/health/ready/  # database reachable
```

Expected:

```json
{"status": "ok"}
{"status": "ok", "database": "ok"}
```

The health endpoints answer by IP over plain HTTP regardless of
`DJANGO_ALLOWED_HOSTS` and HTTPS redirects (they are used by the image's
`HEALTHCHECK`), and never include configuration or error details.

Production settings (all environment variables, see `.env.example`):
`DJANGO_DEBUG` is off by default; session and CSRF cookies are Secure unless
`DJANGO_DEBUG=true`; `DJANGO_CSRF_TRUSTED_ORIGINS`,
`DJANGO_SECURE_SSL_REDIRECT` and `DJANGO_SECURE_HSTS_*` are configurable; and
Django never trusts `X-Forwarded-Proto` itself: Gunicorn honours it only from
the addresses in `FORWARDED_ALLOW_IPS` ([docs/security.md](docs/security.md)).

## Agent authentication (server)

Agents authenticate with a Bearer token. Sentinel stores only an HMAC-SHA256
hash of the token (peppered with `AGENT_TOKEN_PEPPER`). The raw token is shown
once at creation and is never logged or persisted. Rotating
`AGENT_TOKEN_PEPPER` invalidates existing agent tokens; rotating
`DJANGO_SECRET_KEY` does not.

In the admin, adding an agent generates its token, and the **Regenerate
authentication token** action (requires the *change agent* permission and a
confirmation step) replaces it. The raw token is shown once on a page that
browsers and proxies must not cache; it never goes through Django's messages
cookie or the session, and each rotation is recorded in the admin history
without the token. The previous token stops working immediately.

Manual heartbeat with curl:

```bash
curl -X POST http://localhost:8000/api/v1/agent/heartbeat/ \
  -H "Authorization: Bearer <agent-token>" \
  -H "Content-Type: application/json"
```

## Project layout

```text
apps/                  Django applications
  core/                Health endpoints, shared payload validators, retention helpers
  infrastructure/      Monitored servers, telemetry, Docker state
  agents/              Agent registration and heartbeat API
  network/             Network targets and measurement history
  inventory/           Customers, sites and network devices
agent/                 Standalone host agent (no Django imports); own pyproject.toml
sentinel/              Django project settings and URL routing
deploy/systemd/        Hardened agent unit, environment template, Docker drop-in
docs/                  Deployment, operations and security guides
requirements/          Hash-pinned server dependencies for the Docker image
scripts/               Maintenance scripts (regenerate requirements/server.txt)
tests/                 Packaging and deployment-file tests
.github/               CI workflow and Dependabot configuration
manage.py
compose.yml            Server stack; compose.tunnel.yml adds Cloudflare Tunnel
Dockerfile             Server image (agent not included)
gunicorn.conf.py       Gunicorn settings used by the image
pyproject.toml         Server distribution (dependency ranges)
```

New Django apps belong under `apps/` and in `INSTALLED_APPS`.

## License

SSphere Sentinel is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

Copyright © 2026 Alexandros Goulas.
