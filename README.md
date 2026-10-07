# SSphere Sentinel

Self-hosted infrastructure monitoring and backup verification platform.

SSphere Sentinel will eventually monitor servers, Docker containers, services,
health checks, and backups. This repository currently contains only the initial
project foundation.

## Status

**Early development / foundation only.**

The current release scaffolds a Django project with PostgreSQL, Docker Compose,
environment-based configuration, and a basic health endpoint. Product features
(monitoring, backup verification, agents, and similar) are not implemented yet.

## Requirements

- Docker and Docker Compose
- Python 3.12+ (optional, for local non-Docker development)

## Quick start (Docker)

1. Copy the example environment file and set secrets:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and replace placeholder values for `DJANGO_SECRET_KEY`,
   `AGENT_TOKEN_PEPPER`, and `POSTGRES_PASSWORD`.

2. Build and start the stack:

   ```bash
   docker compose up --build
   ```

3. Verify the health endpoint:

   ```bash
   curl http://localhost:8000/health/
   ```

   Expected response:

   ```json
   {"status": "ok"}
   ```

The Compose stack runs:

- `web` — Django application (Gunicorn)
- `db` — PostgreSQL 16

On startup, the web container waits for PostgreSQL and applies migrations.

## Local development (optional)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .

cp .env.example .env
# Point POSTGRES_HOST at a reachable PostgreSQL instance, then:
export $(grep -v '^#' .env | xargs)

python manage.py migrate
python manage.py runserver
python manage.py check
```

## Project layout

```text
apps/           Django applications (add new apps here)
  core/         Shared/core app (health endpoint)
  infrastructure/  Monitored servers
  agents/       Agent registration and heartbeat API
agent/          Standalone host agent (no Django imports)
sentinel/       Django project settings and URL routing
manage.py       Django management entrypoint
compose.yml     Docker Compose services
Dockerfile      Application image
pyproject.toml  Python dependencies and packaging
```

New Django apps should live under `apps/` and be registered in
`sentinel/settings.py` (`INSTALLED_APPS`).

## Running the host agent

The `agent/` package is independent of Django. On a monitored host (after
`pip install -e .` or an equivalent install that provides the `sentinel-agent`
console script):

```bash
export SENTINEL_URL=https://sentinel.example.com
export SENTINEL_AGENT_TOKEN=<token>

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

Use HTTPS for normal deployments. The agent sends
`Authorization: Bearer <token>` and never puts the token in the URL.

## Agent authentication and heartbeat

Agents authenticate with a Bearer token. Sentinel stores only an HMAC-SHA256
hash of the token (peppered with `AGENT_TOKEN_PEPPER`). The raw token is shown
once at creation and is never logged or persisted. Rotating
`AGENT_TOKEN_PEPPER` invalidates existing agent tokens; rotating
`DJANGO_SECRET_KEY` does not.

### Create an agent

1. Create a `Server` in Django admin (or the shell).
2. Issue a token:

   ```bash
   python manage.py create_agent --server <server-uuid> --name server-agent
   ```

3. Copy the printed raw token immediately. It cannot be recovered later.

You can also regenerate a token from Django admin via the
**Regenerate authentication token** action (shown once in the admin message).

### Send a heartbeat

```bash
curl -X POST http://localhost:8000/api/v1/agent/heartbeat/ \
  -H "Authorization: Bearer <agent-token>" \
  -H "Content-Type: application/json"
```

Successful response:

```json
{"status": "ok"}
```

A valid heartbeat updates `Agent.last_seen_at`, `Server.last_seen_at`, and sets
`Server.status` to `online`. Put the token only in the `Authorization` header —
never in the URL or query string.

## Configuration

All secrets and environment-specific settings come from environment variables.
See `.env.example` for the supported keys. Never commit a real `.env` file.
