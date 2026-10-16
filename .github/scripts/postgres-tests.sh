#!/usr/bin/env bash
# The PostgreSQL-backed tests of the separate database logins
# (apps/core/tests/*_postgres.py) on a disposable cluster of their own, as the
# postgres job of .github/workflows/ci.yml runs them:
#
#   postgres-tests.sh start                  initdb and start the cluster (SCRAM, a random password)
#   postgres-tests.sh run password-free      the tests; the password in PGPASSWORD only
#   postgres-tests.sh run password-in-dsn    the tests; the password in SENTINEL_TEST_POSTGRES only
#   postgres-tests.sh stop                   stop the cluster and remove it
#
# Environment: POSTGRES_BINDIR, the programs of PostgreSQL
# SENTINEL_TEST_POSTGRES_MAJOR; SENTINEL_TEST_PORT; SENTINEL_TEST_CLUSTER, a
# directory of its own (default: $RUNNER_TEMP/sentinel-postgres); PYTHON, the
# interpreter of the server's environment (default: python).
#
# The cluster holds nothing but what initdb makes: the separate logins refuse
# any other (sentinel/db_roles.py DEDICATED_CLUSTER). The tests run strict
# (SENTINEL_TEST_STRICT=1): a skip fails, and postgres-tests-report.py fails a
# run in which a module ran nothing or Django created its own test database,
# which none of these tests uses. The password goes to the tests through the
# environment, never a command line.
set -euo pipefail

command=${1:-}
: "${POSTGRES_BINDIR:?}" "${SENTINEL_TEST_POSTGRES_MAJOR:?}" "${SENTINEL_TEST_PORT:?}"
cluster=${SENTINEL_TEST_CLUSTER:-${RUNNER_TEMP:?}/sentinel-postgres}
python=${PYTHON:-python}
data="$cluster/data"
password_file="$cluster/password"

server_version() {
    PGPASSWORD=$(cat "$password_file") "$POSTGRES_BINDIR/psql" -X -At -h 127.0.0.1 -p "$SENTINEL_TEST_PORT" \
        -U postgres -d postgres -c "SELECT pg_catalog.current_setting('server_version')"
}

case "$command" in
    start)
        major=$("$POSTGRES_BINDIR/postgres" --version | sed -E 's/.*\(PostgreSQL\) ([0-9]+).*/\1/')
        if [ "$major" != "$SENTINEL_TEST_POSTGRES_MAJOR" ]; then
            echo "postgres-tests: $POSTGRES_BINDIR is PostgreSQL $major, not $SENTINEL_TEST_POSTGRES_MAJOR" >&2
            exit 1
        fi
        if [ -e "$cluster" ]; then
            echo "postgres-tests: $cluster exists already" >&2
            exit 1
        fi
        (
            umask 077
            mkdir -p "$cluster"
            "$python" -c 'import secrets; print(secrets.token_urlsafe(32))' > "$password_file"
        )
        if [ "${GITHUB_ACTIONS:-}" = true ]; then
            echo "::add-mask::$(cat "$password_file")"
        fi
        "$POSTGRES_BINDIR/initdb" -D "$data" -U postgres --auth=scram-sha-256 --pwfile="$password_file" \
            -E UTF8 --locale=C > "$cluster/initdb.log"
        "$POSTGRES_BINDIR/pg_ctl" -D "$data" -l "$cluster/server.log" -w \
            -o "-p $SENTINEL_TEST_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start > /dev/null
        echo "postgres-tests: PostgreSQL $(server_version) on 127.0.0.1:$SENTINEL_TEST_PORT"
        ;;
    run)
        mode=${2:-}
        dsn="host=127.0.0.1 port=$SENTINEL_TEST_PORT user=postgres dbname=postgres"
        version=$(server_version)
        case "$mode" in
            password-free) export SENTINEL_TEST_POSTGRES="$dsn" PGPASSWORD; PGPASSWORD=$(cat "$password_file") ;;
            password-in-dsn) export SENTINEL_TEST_POSTGRES; SENTINEL_TEST_POSTGRES="$dsn password=$(cat "$password_file")"; unset PGPASSWORD ;;
            *) echo "usage: postgres-tests.sh run password-free|password-in-dsn" >&2; exit 2 ;;
        esac
        export PATH="$POSTGRES_BINDIR:$PATH" SENTINEL_TEST_STRICT=1 PYTHONDONTWRITEBYTECODE=1
        modules=()
        while IFS= read -r path; do
            modules+=("$(echo "${path%.py}" | tr / .)")
        done < <(find apps/core/tests -name '*_postgres.py' | sort)
        log="$cluster/tests-$mode.log"
        status=0
        "$python" manage.py test --noinput -v 2 "${modules[@]}" 2>&1 | tee "$log" || status=$?
        "$python" .github/scripts/postgres-tests-report.py --log "$log" --mode "$mode" \
            --server "PostgreSQL $version" "${modules[@]}" || status=1
        exit "$status"
        ;;
    stop)
        if [ -d "$data" ]; then
            "$POSTGRES_BINDIR/pg_ctl" -D "$data" -m immediate -w stop > /dev/null || true
        fi
        rm -rf "$cluster"
        ;;
    *)
        sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//' >&2
        exit 2
        ;;
esac
