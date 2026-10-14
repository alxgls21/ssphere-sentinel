#!/usr/bin/env bash
# Separate database roles (SENTINEL_DB_ROLES=separate) on a new PostgreSQL 18
# installation: the migrate service applies the migrations with its own login
# and as the owner role, web runs as the application role, and the migration
# password never reaches web. The three roles are created by hand here, as a
# test fixture.
#
# Needs the .env made by ci-env.sh and a host without database volumes.
# `docker compose down --volumes` removes what it creates; .env.migrate stays,
# because .env names it and Compose needs it to load the project.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

grep -qx 'SENTINEL_POSTGRES_INITIALIZE=true' .env || fail "run ci-env.sh first"
[ ! -e .env.migrate ] || fail ".env.migrate exists"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
sql() { docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'; }
container() { docker compose ps --all --quiet "$1"; }
web_sql() {  # web_sql <statement>: run as the application, print the first column
    docker compose exec -T web python manage.py shell --no-imports -v 0 -c \
        "from django.db import connection; cursor = connection.cursor(); cursor.execute('$1'); print(cursor.fetchone()[0])"
}

app=$(secret)
migration=$(secret)
printf 'SENTINEL_DB_ROLES=separate\nSENTINEL_DB_PASSWORD=%s\nSENTINEL_MIGRATE_ENV_FILE=.env.migrate\n' "$app" >> .env
printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$migration" > .env.migrate

step "Create the roles before the first start of the application"
docker compose up --detach --wait --wait-timeout 180 db
docker compose exec -T db sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -v ON_ERROR_STOP=1 -v app="$1" -v migration="$2"' \
    sh "$app" "$migration" <<'SQL'
CREATE ROLE sentinel_owner NOLOGIN;
CREATE ROLE sentinel_migrate LOGIN NOINHERIT PASSWORD :'migration';
CREATE ROLE sentinel_app LOGIN NOINHERIT PASSWORD :'app';
GRANT sentinel_owner TO sentinel_migrate WITH INHERIT FALSE, SET TRUE;
SELECT format('GRANT CONNECT ON DATABASE %I TO sentinel_migrate, sentinel_app', current_database()) \gexec
GRANT USAGE, CREATE ON SCHEMA public TO sentinel_owner;
GRANT USAGE ON SCHEMA public TO sentinel_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sentinel_app;
SQL

step "Start: migrate applies the migrations, then web starts"
docker compose up --detach --build --wait --wait-timeout 180
id=$(container migrate)
[ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id")" = "exited 0" ] \
    || fail "the migrate service did not exit 0"
grep -q 'entrypoint: applying database migrations' <<<"$(docker logs "$id" 2>&1)" || fail "migrate applied nothing"
if grep -q 'applying database migrations' <<<"$(docker compose logs web 2>&1)"; then
    fail "web applied migrations"
fi
owners=$(echo "SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace = 'public'::regnamespace;" | sql)
[ "$owners" = sentinel_owner ] || fail "schema objects are owned by: $owners"
[ "$(web_sql 'SELECT current_user')" = sentinel_app ] || fail "web does not run as sentinel_app"
docker compose exec -T web python manage.py migrate --check

step "The migration password stays in the migrate service"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(container web)" > "$work/web"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" > "$work/migrate"
docker compose exec -T web env > "$work/web-session"
if grep -qF "$migration" "$work/web"; then fail "web received the migration password"; fi
if grep -qF "$migration" "$work/web-session"; then fail "a web session sees the migration password"; fi
grep -qxF "SENTINEL_DB_MIGRATE_PASSWORD=$migration" "$work/migrate" || fail "migrate lacks its password"

step "The application role cannot change the schema"
docker compose exec -T web python manage.py shell --no-imports -v 0 -c "
from django.db import ProgrammingError, connection
try:
    connection.cursor().execute('CREATE TABLE schema_probe (id integer)')
    print('created')
except ProgrammingError as exc:
    print('refused:', exc)
" > "$work/ddl"
grep -q '^refused: permission denied for schema public' "$work/ddl" || { cat "$work/ddl"; fail "web could change the schema"; }

step "A second start: nothing to apply"
docker compose up --detach --wait --wait-timeout 180
grep -q 'No migrations to apply' <<<"$(docker logs "$(container migrate)" 2>&1)" || fail "migrate did not run again"
.github/scripts/check-server.sh

echo "Separate database roles rehearsal passed"
