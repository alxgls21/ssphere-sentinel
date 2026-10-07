#!/bin/sh
set -e

echo "Waiting for database..."
python - <<'PY'
import os
import time

import psycopg

host = os.environ.get("POSTGRES_HOST", "db")
port = os.environ.get("POSTGRES_PORT", "5432")
dbname = os.environ["POSTGRES_DB"]
user = os.environ["POSTGRES_USER"]
password = os.environ["POSTGRES_PASSWORD"]

for attempt in range(30):
    try:
        with psycopg.connect(
            host=host,
            port=port,
            dbname=dbname,
            user=user,
            password=password,
            connect_timeout=3,
        ):
            print("Database is ready.")
            break
    except psycopg.OperationalError:
        if attempt == 29:
            raise
        time.sleep(1)
PY

python manage.py migrate --noinput
exec "$@"
