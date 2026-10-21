#!/usr/bin/env bash
# Rehearses the PostgreSQL 16 -> 18 migration of docs/server-deployment.md on a
# throwaway Compose stack, together with the guarantees around it:
#
#   1. an installation without SENTINEL_POSTGRES keeps the PostgreSQL 16 service it ran before;
#   2. the PostgreSQL 18 service refuses to create an empty database without authorization;
#   3. scripts/postgres-preflight.sh makes the documented decision in every state
#      (new installation, PostgreSQL 16 only, both volumes, PostgreSQL 18 only);
#   4. PostgreSQL 18 refuses to start on the PostgreSQL 16 volume and leaves the cluster intact;
#   5. the documented dump and restore moves the data into a new PostgreSQL 18 volume,
#      and every seeded record (rehearsal_data.py) is there afterwards, column for column;
#   6. an existing PostgreSQL 18 cluster starts without any authorization;
#   7. the documented rollback brings the untouched PostgreSQL 16 volume back.
#
# Needs the .env made by ci-env.sh and a Docker daemon on a host without
# database volumes. Everything it creates is removed by
# `docker compose down --volumes` afterwards.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

preflight=scripts/postgres-preflight.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# New installations select PostgreSQL 18 with a line of .env.example and
# authorize the first start of its empty database.
grep -qx 'SENTINEL_POSTGRES=18' .env || fail ".env does not select PostgreSQL 18"
grep -qx 'SENTINEL_POSTGRES_INITIALIZE=true' .env || fail ".env does not authorize the first start"

edit_env() { grep -v "$1" .env > "$work/.env" && cp "$work/.env" .env; }
use_postgresql_16() { edit_env '^SENTINEL_POSTGRES='; }
use_postgresql_18() { use_postgresql_16 && echo 'SENTINEL_POSTGRES=18' >> .env; }
authorize_initialization() { revoke_initialization && echo 'SENTINEL_POSTGRES_INITIALIZE=true' >> .env; }
revoke_initialization() { edit_env '^SENTINEL_POSTGRES_INITIALIZE='; }

# run_preflight <version|-> <expected status> <expected text> [options]
# Runs the preflight with the selection of .env (-) or with SENTINEL_POSTGRES=<version>.
run_preflight() {
    local version=$1 want=$2 text=$3 output status=0
    shift 3
    if [ "$version" = - ]; then
        output=$("$preflight" "$@" 2>&1) || status=$?
    else
        output=$(SENTINEL_POSTGRES=$version "$preflight" "$@" 2>&1) || status=$?
    fi
    echo "$output"
    [ "$status" -eq "$want" ] || fail "preflight [$version] $* exited $status, expected $want"
    grep -q -- "$text" <<<"$output" || fail "preflight [$version] $* did not say: $text"
}

sql() { docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'; }
server_version() { echo 'SHOW server_version_num;' | sql; }
data_directory() { echo 'SHOW data_directory;' | sql; }

# Exact row count of every table, to compare before and after. Not those of the
# alert engine, which writes on its own while it runs (its evaluation of the
# seeded objects), nor the setup code, which web replaces at every start while
# there is no user and removes once there is (apps/console/setup.py): the dump
# and restore carry them like any other table.
table_counts() {
    sql <<'SQL'
SELECT table_name || ' ' || (xpath('/row/c/text()',
    query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'alerts\_%'
    AND table_name <> 'console_setupcode'
ORDER BY 1;
SQL
}

# rehearsal <seed|fingerprint>: run .github/scripts/rehearsal_data.py in the web
# container. The code is passed with -c (the shell's stdin path only runs what
# is already readable) and the shell is told not to import models or announce
# it: that notice goes to stdout, in front of what the script prints.
rehearsal() {
    docker compose exec -T --env "REHEARSAL_ACTION=$1" web \
        python manage.py shell --no-imports -v 0 -c "$(cat .github/scripts/rehearsal_data.py)"
}

# The seeded records, as the database holds them now, must be those seeded before the migration.
assert_rehearsal_data() {  # assert_rehearsal_data <where>
    rehearsal fingerprint > "$work/data-now" || fail "the test data cannot be read $1"
    diff -u "$work/data-before" "$work/data-now" || fail "the test data differs $1"
}

volume_name() { docker volume ls --quiet --filter "label=com.docker.compose.volume=$1"; }

step "A new installation: the preflight accepts it and the database refuses to initialize unauthorized"
run_preflight 18 0 "new installation"
run_preflight 16 0 "new installation"
revoke_initialization
docker compose up --detach db
docker wait "$(docker compose ps --all --quiet db)" > "$work/exit-code"
[ "$(cat "$work/exit-code")" != 0 ] || fail "the database started without authorization"
logs=$(docker compose logs db 2>&1)
grep -q 'creating one is not authorized' <<<"$logs" || { echo "$logs"; fail "the guard did not explain the refusal"; }
# Compose creates the volume before the container refuses: it is empty, and
# nothing else of the project exists yet, so it can go.
docker compose down --volumes
[ -z "$(docker volume ls --quiet --filter label=com.docker.compose.project)" ] \
    || fail "volumes of the project remain after the cleanup"
authorize_initialization

step "An installation without SENTINEL_POSTGRES keeps its PostgreSQL 16 service"
use_postgresql_16
resolved=$(docker compose config)
grep -q 'image: postgres:16-alpine' <<<"$resolved" || fail "default image is not postgresql 16"
# Compose resolves the service to the very configuration earlier releases ran,
# so updating the repository does not recreate or change the database container.
[ "$(docker compose config --hash db)" = \
    "$(docker compose --file tests/deployment/postgres16-reference.yml --project-directory . config --hash db)" ] \
    || fail "the PostgreSQL 16 service differs from the one earlier releases ran"
docker compose up --detach --build --wait --wait-timeout 180
[ "$(server_version)" -lt 170000 ] || fail "not running PostgreSQL 16"
[ "$(data_directory)" = "/var/lib/postgresql/data" ] || fail "unexpected data directory $(data_directory)"
rehearsal seed
rehearsal fingerprint > "$work/data-before"
grep -q '^rehearsal total rows=' "$work/data-before" || fail "the test data was not created"
table_counts > "$work/counts-before"
[ "$(grep -c . "$work/counts-before")" -gt 10 ] || fail "row counts were not collected"
# The same records, counted by the database itself rather than through the application.
for expected in 'agents_agent 1' 'auth_user 1' 'infrastructure_dockercontainer 2' \
    'infrastructure_dockerhoststate 1' 'infrastructure_server 1' 'infrastructure_servertelemetry 1' \
    'infrastructure_servertelemetrysample 3' 'inventory_customer 1' 'inventory_site 1' \
    'network_networkmeasurement 4' 'network_networktarget 2'; do
    grep -qx "$expected" "$work/counts-before" || fail "the database does not hold the seeded rows: $expected"
done

step "The preflight recognises the PostgreSQL 16 installation and refuses the unsafe switch"
run_preflight - 0 "existing PostgreSQL 16 installation"
run_preflight 16 0 "existing PostgreSQL 16 installation"
run_preflight 18 1 "empty PostgreSQL 18 database"
run_preflight 18 0 "migration authorised" --migrate
run_preflight 16 0 "existing PostgreSQL 16 installation" --confirm 18

step "PostgreSQL 18 does not touch the PostgreSQL 16 volume"
docker compose down
volume=$(volume_name postgres_data)
[ -n "$volume" ] || fail "the PostgreSQL 16 volume was not found"
if docker run --rm --env POSTGRES_HOST_AUTH_METHOD=trust --volume "$volume:/var/lib/postgresql" \
    postgres:18-alpine >"$work/refused.log" 2>&1; then
    fail "PostgreSQL 18 started on a PostgreSQL 16 volume"
fi
grep -q 'there appears to be PostgreSQL data in' "$work/refused.log" \
    || { cat "$work/refused.log"; fail "PostgreSQL 18 did not refuse for the expected reason"; }
[ "$(docker run --rm --entrypoint cat --volume "$volume:/data:ro" postgres:16-alpine /data/PG_VERSION)" = "16" ] \
    || fail "the PostgreSQL 16 cluster changed"

step "Back up (documented procedure)"
run_preflight - 0 "existing PostgreSQL 16 installation"
docker compose up --detach --wait --wait-timeout 180
table_counts | diff - "$work/counts-before" || fail "counts changed after the refused start"
docker compose stop web alert-engine notifier
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
    > "$work/sentinel.dump"
docker compose exec -T db sh -c 'pg_restore --list' < "$work/sentinel.dump" > /dev/null \
    || fail "the dump cannot be read back"
docker compose down

step "Restore into PostgreSQL 18 (documented procedure)"
use_postgresql_18
authorize_initialization
run_preflight - 0 "migration authorised" --migrate
docker compose up --detach --wait --wait-timeout 180 db
[ "$(server_version)" -ge 180000 ] || fail "not running PostgreSQL 18"
[ "$(data_directory)" = "/var/lib/postgresql/18/docker" ] || fail "unexpected data directory $(data_directory)"
docker compose exec -T db sh -c \
    'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --single-transaction --exit-on-error' \
    < "$work/sentinel.dump"
docker compose exec -T db sh -c 'vacuumdb -U "$POSTGRES_USER" -d "$POSTGRES_DB" --analyze-only'
table_counts | diff -u "$work/counts-before" - || fail "row counts differ after the restore"

step "Both volumes exist: the preflight asks for a confirmation and never changes a volume"
docker volume inspect "$(volume_name postgres_data)" "$(volume_name postgres18_data)" > "$work/volumes-before"
run_preflight - 2 "AMBIGUOUS"
run_preflight - 1 "selects PostgreSQL 18" --confirm 16
run_preflight - 0 "PostgreSQL 18 confirmed" --confirm 18
run_preflight 16 1 "selects PostgreSQL 16" --confirm 18
run_preflight - 2 "AMBIGUOUS" --migrate
docker volume inspect "$(volume_name postgres_data)" "$(volume_name postgres18_data)" > "$work/volumes-after"
diff "$work/volumes-before" "$work/volumes-after" || fail "the preflight changed a volume"

step "The application runs on the restored PostgreSQL 18 database, without authorization"
# The cluster exists, so the authorization is no longer needed (nor wanted).
revoke_initialization
run_preflight - 0 "PostgreSQL 18 confirmed" --confirm 18
docker compose up --detach --wait --wait-timeout 180
docker compose exec -T web python manage.py migrate --check
assert_rehearsal_data "after the restore"
.github/scripts/check-server.sh
docker compose stop web alert-engine notifier
table_counts | diff -u "$work/counts-before" - || fail "row counts changed while the application ran"

step "Roll back to the untouched PostgreSQL 16 volume (documented procedure)"
docker compose down
use_postgresql_16
run_preflight - 2 "AMBIGUOUS"
run_preflight - 1 "selects PostgreSQL 16" --confirm 18
run_preflight - 0 "PostgreSQL 16 confirmed" --confirm 16
docker compose up --detach --wait --wait-timeout 180 db
[ "$(server_version)" -lt 170000 ] || fail "rollback did not return to PostgreSQL 16"
table_counts | diff -u "$work/counts-before" - || fail "row counts differ after the rollback"
docker compose up --detach --wait --wait-timeout 180
assert_rehearsal_data "after the rollback"

step "Retire the PostgreSQL 16 volume: the PostgreSQL 18 database starts without authorization"
docker compose down
docker volume rm "$(volume_name postgres_data)"
use_postgresql_18
run_preflight - 0 "existing PostgreSQL 18 installation"
run_preflight 16 1 "no PostgreSQL 16 data"
docker compose up --detach --wait --wait-timeout 180
[ "$(server_version)" -ge 180000 ] || fail "not running PostgreSQL 18"
assert_rehearsal_data "in the PostgreSQL 18 database once the PostgreSQL 16 volume is retired"

echo "PostgreSQL migration rehearsal passed"
