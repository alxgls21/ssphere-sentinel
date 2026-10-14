#!/bin/sh
# Container entrypoint: wait for PostgreSQL, apply migrations, then exec the
# command (Gunicorn by default) so it replaces this shell and receives SIGTERM
# directly for a graceful shutdown.
#
# Who applies the migrations depends on SENTINEL_DB_ROLES (sentinel/database.py):
#   legacy (default)  the web container, as it starts; the one-shot migrate
#                     service (command apply-migrations) has nothing to do.
#   separate          the migrate service, with its own login; the web
#                     container only waits for the database.
set -eu

# "<roles> <access>", e.g. "legacy runtime"; unknown values stop here.
mode=$(python -m sentinel.database mode)

if [ "$mode" = "legacy migrate" ]; then
    if [ "${1:-}" = apply-migrations ]; then
        echo "entrypoint: SENTINEL_DB_ROLES is legacy: the web service applies the migrations, nothing to do here" >&2
        exit 0
    fi
    echo "entrypoint: SENTINEL_DB_ROLES is legacy: run manage.py commands in the web service" >&2
    exit 2
fi
if [ "${1:-}" = apply-migrations ] && [ "$mode" != "separate migrate" ]; then
    echo "entrypoint: apply-migrations only runs in the migrate service" >&2
    exit 2
fi

echo "entrypoint: waiting for the database at ${POSTGRES_HOST:-db}:${POSTGRES_PORT:-5432}" >&2
python -m sentinel.database wait

case "$mode" in
    "legacy runtime")
        echo "entrypoint: applying database migrations" >&2
        python manage.py migrate --noinput
        ;;
    "separate migrate")
        if [ "${1:-}" = apply-migrations ]; then
            echo "entrypoint: applying database migrations" >&2
            python manage.py migrate --noinput
            exit 0
        fi
        ;;
    "separate runtime") ;;
    *)
        echo "entrypoint: unexpected database mode: $mode" >&2
        exit 2
        ;;
esac

exec "$@"
