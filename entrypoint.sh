#!/bin/sh
# Container entrypoint: wait for PostgreSQL, apply migrations, then exec the
# command (Gunicorn by default) so it replaces this shell and receives SIGTERM
# directly for a graceful shutdown.
#
# Who applies the migrations depends on SENTINEL_DB_ROLES (sentinel/database.py):
#   legacy (default)  the web container, as it starts; the one-shot migrate
#                     service (command apply-migrations) has nothing to do.
#   separate          the migrate service, with its own login, which checks
#                     the roles before it runs anything (django_migrations
#                     included) and verifies what the runtime login holds
#                     after the migrations; the web container waits for the
#                     database and verifies the same.
#
# SENTINEL_PROCESS=worker (the alert engine, the notifier, the domain verifier): the
# runtime login, like web, but never the migrations, in either arrangement: in the
# legacy one the web service applies them, and the worker waits until it has.
set -eu

# "<roles> <access>", e.g. "legacy runtime"; unknown values, and a password
# this process must not have, stop here.
mode=$(python -m sentinel.database mode)

process=${SENTINEL_PROCESS:-web}
case "$process" in
    web | worker) ;;
    *)
        echo "entrypoint: SENTINEL_PROCESS must be web or worker" >&2
        exit 2
        ;;
esac
if [ "$process" = worker ] && [ "${mode#* }" != runtime ]; then
    echo "entrypoint: a worker runs with the runtime login (SENTINEL_DB_ACCESS=runtime)" >&2
    exit 2
fi

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
        if [ "$process" = worker ]; then
            echo "entrypoint: worker: the web service applies the migrations" >&2
        else
            echo "entrypoint: applying database migrations" >&2
            python manage.py migrate --noinput
        fi
        ;;
    "separate migrate")
        # Read-only, and before any command of this service, all of which could migrate.
        echo "entrypoint: checking the database roles before anything runs" >&2
        python -m sentinel.database verify
        if [ "${1:-}" = apply-migrations ]; then
            echo "entrypoint: applying database migrations" >&2
            python manage.py migrate --noinput
            echo "entrypoint: verifying the privileges of the runtime login" >&2
            python -m sentinel.database verify
            exit 0
        fi
        ;;
    "separate runtime")
        echo "entrypoint: verifying the privileges of the runtime login" >&2
        python -m sentinel.database verify
        ;;
    *)
        echo "entrypoint: unexpected database mode: $mode" >&2
        exit 2
        ;;
esac

# The web server of an installation without any user: the setup code of its first administrator, in the log
# (apps/console/setup.py). A failure here must not keep the server from starting.
if [ "$process" = web ] && [ "${mode#* }" = runtime ] && [ "${1:-}" = gunicorn ]; then
    python manage.py setup_code || echo "entrypoint: the setup code could not be prepared" >&2
fi

exec "$@"
