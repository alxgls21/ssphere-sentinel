#!/bin/sh
# Container entrypoint: wait for PostgreSQL, apply migrations, then exec the
# command (Gunicorn by default) so it replaces this shell and receives SIGTERM
# directly for a graceful shutdown.
set -eu

echo "entrypoint: waiting for the database at ${POSTGRES_HOST:-db}:${POSTGRES_PORT:-5432}" >&2
python - <<'PY'
import os
import sys
import time

import psycopg

for attempt in range(1, 31):
    try:
        with psycopg.connect(
            host=os.environ.get("POSTGRES_HOST", "db"),
            port=os.environ.get("POSTGRES_PORT", "5432"),
            dbname=os.environ["POSTGRES_DB"],
            user=os.environ["POSTGRES_USER"],
            password=os.environ["POSTGRES_PASSWORD"],
            connect_timeout=3,
        ):
            break
    except psycopg.OperationalError as exc:
        if attempt == 30:
            print(f"entrypoint: database unavailable: {exc}", file=sys.stderr)
            sys.exit(1)
        time.sleep(1)
PY

echo "entrypoint: applying database migrations" >&2
python manage.py migrate --noinput

exec "$@"
