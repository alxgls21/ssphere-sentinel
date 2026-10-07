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
python manage.py test apps.infrastructure apps.agents

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
  seconds (default **30**)
- logs failures and keeps running
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
  infrastructure/      Monitored servers
  agents/              Agent registration and heartbeat API
agent/                 Standalone host agent (no Django imports)
sentinel/              Django project settings and URL routing
manage.py
compose.yml
Dockerfile
pyproject.toml         Primary Python dependency definition
```

New Django apps belong under `apps/` and in `INSTALLED_APPS`.
