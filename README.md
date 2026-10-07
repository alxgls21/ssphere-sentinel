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

   Edit `.env` and replace placeholder values for `DJANGO_SECRET_KEY` and
   `POSTGRES_PASSWORD`.

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
  core/         Shared/core app (health endpoint for now)
sentinel/       Django project settings and URL routing
manage.py       Django management entrypoint
compose.yml     Docker Compose services
Dockerfile      Application image
pyproject.toml  Python dependencies and packaging
```

New Django apps should live under `apps/` and be registered in
`sentinel/settings.py` (`INSTALLED_APPS`).

## Configuration

All secrets and environment-specific settings come from environment variables.
See `.env.example` for the supported keys. Never commit a real `.env` file.
