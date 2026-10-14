#!/usr/bin/env bash
# Updates an installation of the last release without the migrate service
# (main at PREVIOUS, PostgreSQL 16, an .env made from its .env.example) to the
# checked-out commit and back, the way an operator does it: same directory,
# same .env, `docker compose up -d --build`. Checks that
#   1. the database container and its volume survive the update, a Docker
#      restart and the rollback untouched (same container, never restarted by
#      Compose);
#   2. the unchanged .env needs no new setting: the migrate service exits 0
#      without a database connection and web applies the migrations as before;
#   3. web does not receive a migration password;
#   4. the documented restore ends with `docker compose up -d`, also after the
#      exited migrate container was removed (as `docker container prune` does);
#   5. the previous release starts again once the migrate container is
#      removed as documented, and a second update works.
#
# CI only: it checks out other commits (run a copy from outside the working
# tree) and restarts the Docker daemon. Everything it creates, looks up or
# removes belongs to a Compose project of its own, removed at the end.
#
# Ownership comes first. The script changes nothing on the host, and arms no
# cleanup, until it has established that its Compose project is new: no
# container, no volume. A lookup that fails, an answer that is not a list of
# identifiers, or a project that already exists ends the script there, with
# nothing created and nothing removed. Only then does the EXIT trap, which
# tears the project down with `docker compose down --volumes`, become active.
set -euo pipefail

PREVIOUS=9091e51c596d9f5e1a5075e754a08602480545dd

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

[ "${CI:-}" = true ] || fail "CI only: it checks out other commits and restarts the Docker daemon"

# A project name no other stack on the host uses: the process ID and a random
# token. Every docker compose command below inherits it, and it cannot change.
token=$(python3 -c 'import secrets; print(secrets.token_hex(4))') || fail "cannot generate a project name"
[[ $token =~ ^[0-9a-f]{8}$ ]] || fail "unexpected project name token: $token"
COMPOSE_PROJECT_NAME=sentinel-upgrade-rehearsal-$$-$token
export COMPOSE_PROJECT_NAME
readonly COMPOSE_PROJECT_NAME
project=$COMPOSE_PROJECT_NAME

# --- project-scoped lookups
# Every container and volume lookup and removal outside `docker compose` is
# limited to the rehearsal project, and a lookup that fails is an error, never
# an empty answer. tests/deployment/test_compose_rehearsal.py runs these
# functions, and the whole script, among containers and volumes of other
# projects.

# The identifiers (container IDs or volume names, one per line) that
# `docker <arguments>` prints. A failing docker, or an answer that is not a
# list of identifiers, is an error.
docker_ids() {
    local output line status=0
    output=$(docker "$@") || status=$?
    if [ "$status" -ne 0 ]; then
        echo "docker $* failed with status $status" >&2
        return 1
    fi
    if [ -n "$output" ]; then
        while IFS= read -r line; do
            [[ $line =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || {
                echo "unexpected answer to docker $*: $line" >&2
                return 1
            }
        done <<<"$output"
        printf '%s\n' "$output"
    fi
}
project_containers() {
    docker_ids ps --all --quiet --filter "label=com.docker.compose.project=$project"
}
project_volumes() {
    docker_ids volume ls --quiet --filter "label=com.docker.compose.project=$project"
}
project_resources() {
    project_containers && project_volumes
}
# Containers of the migrate service, whether or not the checked-out release defines it.
migrate_containers() {
    docker_ids ps --all --quiet --filter "label=com.docker.compose.project=$project" \
        --filter label=com.docker.compose.service=migrate
}
postgres_volume() {
    docker_ids volume ls --quiet --filter "label=com.docker.compose.project=$project" \
        --filter label=com.docker.compose.volume=postgres_data
}
# The project must be new. Whatever it already holds, or a lookup that cannot
# tell, ends the script before it has created or removed anything.
claim_project() {
    local found
    found=$(project_resources) || fail "cannot establish that project $project is unused"
    [ -z "$found" ] || fail "project $project already exists, refusing to use it: $(tr '\n' ' ' <<<"$found")"
}
# What `docker container prune` does to the exited migrate container, limited
# to that one container of this project.
remove_exited_migrate() {
    local ids
    ids=$(migrate_containers) || fail "cannot list the migrate containers of project $project"
    [ "$(wc -w <<<"$ids")" -eq 1 ] || fail "expected one migrate container, found: $ids"
    [ "$(docker inspect --format '{{.State.Status}}' "$ids")" = exited ] || fail "the migrate container is running"
    docker container rm "$ids" > /dev/null
}
# The project has no migrate container; $1 says what is wrong if it has one.
assert_no_migrate_container() {
    local ids
    ids=$(migrate_containers) || fail "cannot list the migrate containers of project $project"
    [ -z "$ids" ] || fail "$1"
}
# --- end of project-scoped lookups

workspace=${GITHUB_WORKSPACE:-}
[ -n "$workspace" ] || workspace=$(git rev-parse --show-toplevel) || fail "cannot find the working tree"
cd "$workspace"
current=$(git rev-parse HEAD)
changes=$(git status --porcelain --untracked-files=no) || fail "cannot inspect the working tree"
[ -z "$changes" ] || fail "the working tree has changes"
[ ! -e .env ] || fail ".env exists: run this on a fresh checkout"

docker compose version
claim_project

# Runs on every exit from here on: the project is new and this rehearsal's own.
# The script's exit status is kept, whatever the cleanup commands do.
cleanup() {
    local status=$?
    trap - EXIT
    set +e
    # The logs, before the stack and the .env it needs are gone.
    [ "$status" -eq 0 ] || docker compose logs --no-color
    docker compose down --volumes --remove-orphans > /dev/null 2>&1
    git checkout --quiet --detach "$current"
    [ -z "$work" ] || rm -rf "$work"
    rm -f .env
    exit "$status"
}
work=
# Armed only now: a project found in use, or not found at all, is never torn down.
trap cleanup EXIT
work=$(mktemp -d)

checkout() { git checkout --quiet --detach "$1"; }
secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
sql() { docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'; }
accounts() { echo "SELECT username || ' ' || password FROM auth_user ORDER BY 1;" | sql; }
container() { docker compose ps --all --quiet "$1"; }
started_at() { docker inspect --format '{{.State.StartedAt}}' "$1"; }
up() { docker compose up --detach --build --wait --wait-timeout 180; }

# The database container must be the same one, still running since it started.
assert_database_untouched() {
    local now
    [ "$(container db)" = "$db" ] || fail "the database container was recreated $1"
    [ "$(started_at "$db")" = "$db_started" ] || fail "the database container was restarted $1"
    now=$(postgres_volume) || fail "cannot list the volumes of project $project"
    [ "$now" = "$volume" ] || fail "the database volume changed $1"
    accounts | diff -u "$work/accounts" - || fail "the data changed $1"
}

# The migrate service of this commit exited 0 without touching the database.
assert_migrate_did_nothing() {
    local id logs
    id=$(container migrate)
    [ -n "$id" ] || fail "no migrate container $1"
    [ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id")" = "exited 0" ] \
        || fail "the migrate service did not exit 0 $1"
    logs=$(docker logs "$id" 2>&1)
    grep -q 'the web service applies the migrations, nothing to do here' <<<"$logs" \
        || fail "the migrate service did not report that it had nothing to do $1"
    if grep -q 'waiting for the database' <<<"$logs"; then
        fail "the migrate service connected to the database $1"
    fi
}

assert_web_has_no_migration_password() {
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(container web)" > "$work/web-env"
    if grep -q '^SENTINEL_DB_MIGRATE_PASSWORD=.' "$work/web-env"; then
        fail "web received a migration password"
    fi
}

wait_healthy() {  # wait_healthy <container>
    for _ in $(seq 90); do
        [ "$(docker inspect --format '{{.State.Health.Status}}' "$1")" = healthy ] && return 0
        sleep 2
    done
    fail "$1 did not become healthy"
}

step "Install the previous release with an .env made from its .env.example"
checkout "$PREVIOUS"
sed -e "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=$(secret)|" \
    -e "s|^AGENT_TOKEN_PEPPER=.*|AGENT_TOKEN_PEPPER=$(secret)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
    .env.example > .env
cp .env "$work/env"
up
docker compose exec -T -e DJANGO_SUPERUSER_PASSWORD="$(secret)" web \
    python manage.py createsuperuser --noinput --username rehearsal --email rehearsal@example.invalid
accounts > "$work/accounts"
grep -q '^rehearsal ' "$work/accounts" || fail "the test account was not created"
db=$(container db)
db_started=$(started_at "$db")
volume=$(postgres_volume) || fail "cannot list the volumes of project $project"
[ -n "$volume" ] || fail "no PostgreSQL 16 volume"

step "Update to the checked-out commit with the unchanged .env"
checkout "$current"
cmp -s .env "$work/env" || fail ".env changed"
grep -q 'existing PostgreSQL 16 installation' <<<"$(scripts/postgres-preflight.sh)" || fail "the preflight did not accept the update"
up
assert_database_untouched "by the update"
assert_migrate_did_nothing "after the update"
grep -q 'entrypoint: applying database migrations' <<<"$(docker compose logs web 2>&1)" \
    || fail "web did not apply the migrations"
docker compose exec -T web python manage.py migrate --check
assert_web_has_no_migration_password
.github/scripts/check-server.sh

step "A second update: nothing to apply, the database is left alone"
up
assert_database_untouched "by a second up"
assert_migrate_did_nothing "after a second up"

step "Docker restarts (host reboot): web returns, migrate stays exited"
migrate_finished=$(docker inspect --format '{{.State.FinishedAt}}' "$(container migrate)")
web=$(container web)
sudo systemctl restart docker
wait_healthy "$db"
wait_healthy "$web"
[ "$(container web)" = "$web" ] || fail "web was recreated by the restart"
[ "$(container db)" = "$db" ] || fail "the database container was recreated by the restart"
[ "$(docker inspect --format '{{.State.FinishedAt}}' "$(container migrate)")" = "$migrate_finished" ] \
    || fail "Docker started the migrate service again"
db_started=$(started_at "$db")  # Docker itself restarted it
accounts | diff -u "$work/accounts" - || fail "the data changed across the restart"

step "Documented restore, after the exited migrate container was removed"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$work/backup.dump"
remove_exited_migrate
assert_no_migrate_container "the migrate container was not removed"
docker compose stop web
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
    < "$work/backup.dump"
docker compose up --detach --wait --wait-timeout 180
assert_database_untouched "by the restore"
assert_migrate_did_nothing "after the restore"

step "Roll back to the previous release (documented procedure)"
docker compose rm --stop --force migrate
assert_no_migrate_container "the migrate container was not removed"
checkout "$PREVIOUS"
up
assert_no_migrate_container "a migrate container exists under the previous release"
assert_database_untouched "by the rollback"
curl --fail --silent --show-error http://127.0.0.1:8000/health/ready/ > /dev/null || fail "the previous release is not ready"

step "Update again"
checkout "$current"
up
assert_database_untouched "by the second update"
assert_migrate_did_nothing "after the second update"
docker compose exec -T web python manage.py migrate --check

echo "Update and rollback rehearsal passed"
