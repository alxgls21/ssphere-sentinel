#!/usr/bin/env bash
# Separate database logins (SENTINEL_DB_ROLES=separate) on real Docker Compose
# containers, on the PostgreSQL major version SENTINEL_E2E_POSTGRES names (16 or
# 18), through the two ways docs/server-deployment.md describes:
#
#   an existing installation   one superuser login, moved to the separate logins:
#                              its bootstrap password leaves .env, scripts/postgres-roles.sh
#                              provisions the logins and hands the tables to the owner role;
#   a new installation         the logins first, then the first migration as the migrate login
#                              (it creates django_migrations itself),
#
# and what an operator meets on the way: an interrupted provisioning (the database server
# killed inside its transaction), a lost acknowledgement, an interrupted migration, a failed
# deployment, password rotation and drift in what the roles may do. Each scenario below says
# what it checks. Where it matters: the credentials of each container (Docker's view of its
# configuration and the environment and command line of its processes, never only the YAML),
# the order the containers start in, that a refused deployment never starts web, and that a
# failed operation does not weaken a privilege (a fingerprint of the privileges of the cluster
# and of the application's database, passwords aside, before and after).
#
# Output for .github/scripts/compose_e2e.py (report): an identification line, the scenarios it
# means to run, "SCENARIO PASS <name>" after each and a result line. A scenario that does not
# run is not a pass: the report fails a run that did not pass every one it announced.
#
# Needs the .env made by `ci-env.sh <16|18>`, SENTINEL_E2E_POSTGRES and COMPOSE_PROJECT_NAME
# (the Compose project it owns, which the CI job removes at the end), and a host without
# database volumes. CI only: it rewrites .env and creates .env.migrate and .env.bootstrap, which
# stay, because .env names them and Compose needs them to load the project. Nothing secret is
# printed, and every secret is masked in a GitHub Actions log.
#
# The functions come first: apps/core/tests/test_compose_e2e_postgres.py sources the file to run
# the ones that need no Docker against a real PostgreSQL (the rest runs only as a script).
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

# The state the scenarios share: the work directory, the passwords, the tables to hand over.
work=${work:-}
postgres=${postgres:-}
app=${app:-}
migration=${migration:-}
bootstrap=${bootstrap:-}
db_hash=
events_pid=
client=
since_epoch=0
retired=()
adopt=()

# What PostgreSQL refuses the logins of the containers (42501, insufficient privilege), as the
# statements the scenarios run in them; apps/core/tests/test_compose_e2e_postgres.py runs the same
# statements against PostgreSQL 16 and 18.
RECORD_WRITES=(
    "INSERT INTO django_migrations (app, name, applied) VALUES ('e2e', 'probe', now())"
    "UPDATE django_migrations SET name = name"
    "DELETE FROM django_migrations"
    "TRUNCATE django_migrations"
)
WEB_REFUSED=(
    "CREATE TABLE schema_probe (id integer)"
    "CREATE SCHEMA schema_probe"
    "ALTER ROLE sentinel_app SUPERUSER"
    "SET ROLE sentinel_owner"
    "CREATE TEMPORARY TABLE temporary_probe (id integer)"
    "SELECT lo_creat(-1)"
    "SELECT lo_from_bytea(0, 'probe')"
)
MIGRATE_REFUSED=(
    "CREATE SCHEMA schema_probe"
    "ALTER ROLE sentinel_owner SUPERUSER"
    "ALTER ROLE sentinel_migrate CREATEDB"
    "CREATE TEMPORARY TABLE temporary_probe (id integer)"
    "SELECT lo_creat(-1)"
    "SELECT lo_from_bytea(0, 'probe')"
    "DROP SCHEMA sentinel_restricted"
)
MARKER_REFUSED_WEB=(
    "DROP SCHEMA sentinel_restricted"
    "COMMENT ON SCHEMA sentinel_restricted IS 'e2e'"
    "CREATE TABLE sentinel_restricted.probe (id integer)"
)
MARKER_REFUSED_MIGRATE=(
    "DROP SCHEMA sentinel_restricted"
    "COMMENT ON SCHEMA sentinel_restricted IS 'e2e'"
)
# What the runtime login may do, and what PostgreSQL says to it (the statement, then the answer).
WEB_ALLOWED=(
    "SELECT count(*) > 0 FROM django_migrations" "ok True"
    "INSERT INTO auth_group (name) VALUES ('e2e probe')" "ok"
    "DELETE FROM auth_group WHERE name = 'e2e probe'" "ok"
    "SELECT count(*) FROM pg_largeobject_metadata" "ok 0"
)
# What apply says of a role of Sentinel's that was renamed: a role of the cluster that is not Sentinel's. The
# topology check comes first in apply's preflight, before the history is read. (status and every start read the
# history first, and say state C.)
RENAMED_ROLE_REFUSAL='this cluster also has role sentinel_app_gone'

# --- secrets

secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
mask() { if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::add-mask::$1"; fi; }
new_secret() {  # new_secret <variable>: a random secret in the variable, masked in the log (no local: any name works)
    printf -v "$1" '%s' "$(secret)"
    mask "${!1}"
}
value_of() { sed -n "s/^$1=//p" .env; }  # a setting of .env
write_secrets() {  # the passwords and keys of the stack, and the retired ones, for compose_e2e.py (a file, never a command line)
    local retired_json="" value
    for value in ${retired[@]+"${retired[@]}"}; do
        retired_json="$retired_json${retired_json:+, }\"$value\""
    done
    (
        umask 077
        printf '{"runtime": ["%s"], "migration": ["%s"], "bootstrap": ["%s"], "django": ["%s"], "pepper": ["%s"], "retired": [%s]}\n' \
            "$app" "$migration" "$bootstrap" "$(value_of DJANGO_SECRET_KEY)" "$(value_of AGENT_TOKEN_PEPPER)" "$retired_json" \
            > "$work/secrets.json"
    )
}

# --- the database, as the bootstrap superuser

sql() { docker compose exec -T db sh -c 'exec psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'; }
# The cluster's other database: a session there is no superuser session in Sentinel's database,
# which the provisioning refuses while another is open.
sql_cluster() { docker compose exec -T db sh -c 'exec psql -X -q -U "$POSTGRES_USER" -d postgres -At -v ON_ERROR_STOP=1'; }
expect() {  # expect <expected> <what> <query>: the answer of Sentinel's database
    local got
    got=$(echo "$3" | sql)
    [ "$got" = "$1" ] || fail "$2: expected '$1', got '$got'"
}
table_owners() {
    echo "SELECT string_agg(DISTINCT pg_get_userbyid(relowner), ',') FROM pg_class WHERE relnamespace = 'public'::regnamespace" | sql
}
managed_roles() {
    echo "SELECT count(*) FROM pg_roles WHERE rolname IN ('sentinel_owner', 'sentinel_migrate', 'sentinel_app')" | sql_cluster
}
marker() {
    echo "SELECT count(*) FROM pg_namespace WHERE nspname = 'sentinel_restricted'" | sql
}
applied_migrations() {
    echo "SELECT count(*) FROM django_migrations" | sql
}

# An MD5 of what the roles may do, in the cluster and in the application's database: roles and their
# attributes, memberships, role settings, the ACLs of databases, tablespaces, parameters, schemas,
# relations (the system catalogs too), columns, functions, types, languages, foreign-data wrappers
# and servers, and large objects, the default privileges and the activation record. Passwords are
# left out (verifiers).
fingerprint() {
    local cluster database
    cluster=$(sql_cluster <<'SQL'
SELECT md5(string_agg(item, E'\n' ORDER BY item)) FROM (
  SELECT format('role %s %s%s%s%s%s%s%s %s %s', rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
                rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil) AS item FROM pg_roles
  UNION ALL SELECT format('member %s in %s admin=%s inherit=%s set=%s', member::regrole, roleid::regrole,
                          admin_option, inherit_option, set_option) FROM pg_auth_members
  UNION ALL SELECT format('database %s owner=%s acl=%s', datname, datdba::regrole, datacl) FROM pg_database
  UNION ALL SELECT format('setting %s %s %s', (SELECT datname FROM pg_database d WHERE d.oid = setdatabase),
                          (SELECT rolname FROM pg_roles r WHERE r.oid = setrole), setconfig) FROM pg_db_role_setting
  UNION ALL SELECT format('tablespace %s owner=%s acl=%s', spcname, spcowner::regrole, spcacl) FROM pg_tablespace
  UNION ALL SELECT format('parameter %s acl=%s', parname, paracl) FROM pg_parameter_acl
) items;
SQL
    )
    database=$(sql <<'SQL'
SELECT md5(string_agg(item, E'\n' ORDER BY item)) FROM (
  SELECT format('schema %s owner=%s acl=%s', nspname, nspowner::regrole, nspacl) AS item FROM pg_namespace
   WHERE nspname !~ '^pg_(toast_)?temp_'
  UNION ALL SELECT format('relation %s kind=%s owner=%s acl=%s', oid::regclass, relkind, relowner::regrole, relacl) FROM pg_class
   WHERE relnamespace = 'public'::regnamespace OR relacl IS NOT NULL
  UNION ALL SELECT format('column %s.%s acl=%s', attrelid::regclass, attname, attacl) FROM pg_attribute WHERE attacl IS NOT NULL
  UNION ALL SELECT format('default %s %s %s %s', defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl)
    FROM pg_default_acl
  UNION ALL SELECT format('function %s acl=%s', oid::regprocedure, proacl) FROM pg_proc
   WHERE proacl IS NOT NULL OR prosrc IN ('be_lo_creat', 'be_lo_create', 'be_lo_from_bytea', 'be_lo_import', 'be_lo_import_with_oid')
  UNION ALL SELECT format('type %s acl=%s', oid::regtype, typacl) FROM pg_type WHERE typacl IS NOT NULL
  UNION ALL SELECT format('language %s acl=%s', lanname, lanacl) FROM pg_language WHERE lanacl IS NOT NULL
  UNION ALL SELECT format('foreign-data wrapper %s acl=%s', fdwname, fdwacl) FROM pg_foreign_data_wrapper WHERE fdwacl IS NOT NULL
  UNION ALL SELECT format('foreign server %s acl=%s', srvname, srvacl) FROM pg_foreign_server WHERE srvacl IS NOT NULL
  UNION ALL SELECT format('large object %s owner=%s acl=%s', oid, lomowner::regrole, lomacl) FROM pg_largeobject_metadata
  UNION ALL SELECT format('record %s %s', nspname, obj_description(oid, 'pg_namespace')) FROM pg_namespace
   WHERE nspname = 'sentinel_restricted'
) items;
SQL
    )
    [ -n "$cluster" ] && [ -n "$database" ] || fail "the fingerprint of the privileges could not be read"
    echo "$cluster $database"
}
# Which stored SCRAM verifier each login has, as digests (never the verifiers): a line for each of the three roles.
verifiers() {
    local output
    output=$(sql_cluster <<'SQL'
SELECT rolname || ' ' || coalesce(md5(rolpassword), 'none') FROM pg_authid
 WHERE rolname IN ('sentinel_owner', 'sentinel_migrate', 'sentinel_app') ORDER BY 1;
SQL
    )
    [ "$(grep -c . <<<"$output")" = 3 ] || { echo "FAIL: the passwords of the three roles could not be read" >&2; return 1; }
    printf '%s\n' "$output"
}
# What the runtime login and PUBLIC may do with django_migrations (the privileges of the table
# and of any column): the runtime login reads it, nobody else does anything.
migrations_privileges() {
    sql <<'SQL'
SELECT who || ' ' || string_agg(privilege, ',' ORDER BY privilege)
  FROM (SELECT r.who, p.privilege
          FROM (VALUES ('app', 'sentinel_app'), ('public', 'public')) r (who, role),
               unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p (privilege)
         WHERE CASE WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                    THEN has_any_column_privilege(r.role, 'django_migrations', p.privilege)
                    ELSE has_table_privilege(r.role, 'django_migrations', p.privilege) END) held
 GROUP BY who ORDER BY who;
SQL
}
# What the documentation tells the operator to take from PUBLIC before the first provisioning.
revoke_public() {
    sql <<'SQL'
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database WHERE datallowconn \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database WHERE datallowconn AND datname <> current_database() \gexec
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),
    pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;
SQL
}

# --- the provisioning, cut short

nonce() { python3 -c 'import secrets; print(secrets.token_hex(16))'; }

# A provisioning program that waits, inside its transaction and once the tables have changed
# hands, on an advisory lock nobody holds, and then in pg_sleep: it neither commits nor
# finishes until its server goes. Standard input in, standard output out.
hold_provisioning() {
    local program
    program=$(cat)
    # shellcheck disable=SC2016
    [ "$(grep -c '^\$sentinel_ownership\$;$' <<<"$program")" = 1 ] || fail "the provisioning program has no ownership block to wait in"
    # shellcheck disable=SC2016
    awk '{ print } /^\$sentinel_ownership\$;$/ { print "SELECT pg_catalog.pg_advisory_xact_lock(4243), pg_catalog.pg_sleep(600);" }' <<<"$program"
}
holds_provisioning() {  # the program has reached its wait: it holds the lock, in a transaction nobody else can see into
    [ "$(echo "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 0 AND objid = 4243 AND objsubid = 1" | sql_cluster)" = 1 ]
}
# A docker that passes everything on but swallows the last line of what the provisioning program
# prints (its acknowledgement of the COMMIT), as a lost connection would.
lose_acknowledgement() {  # lose_acknowledgement <directory>
    mkdir -p "$1"
    cat > "$1/docker" <<'SHIM'
#!/usr/bin/env bash
real=${E2E_REAL_DOCKER:?}
if [ "${1:-}" = compose ] && [ "${2:-}" = exec ] && [[ "$*" == *"exec psql -X -q -U "* ]] && [[ "$*" == *" -f -"* ]]; then
    "$real" "$@" | sed '$d'
    exit "${PIPESTATUS[0]}"
fi
exec "$real" "$@"
SHIM
    chmod +x "$1/docker"
}

# --- Compose

container() { docker compose ps --all --quiet "$1"; }
# The log of a container since the events of the last start or refused start were recorded: a container that
# Compose starts again keeps its log, and what an earlier run said must not satisfy a later check.
service_log() { docker logs --since "$since_epoch" "$(container "$1")" 2>&1; }
migrate_log() { service_log migrate; }
retry() {  # retry <seconds> <what> <command...>: until the command succeeds; a failure says so and returns
    local limit=$1 what=$2 waited=0
    shift 2
    until "$@"; do
        waited=$((waited + 1))
        if [ "$waited" -gt "$limit" ]; then
            echo "FAIL: timed out waiting for $what" >&2
            return 1
        fi
        sleep 1
    done
}
indented() { sed 's/^/  | /'; }
# The db service's health check (pg_isready) is, for a few milliseconds every few seconds, a superuser session in
# Sentinel's database, and apply refuses while another superuser session is open. That is a refusal to run
# again (the message says so), not an answer: what it refused for the second time is the answer.
SESSION_REFUSAL='other superuser sessions use this database'
run_again_if_a_session_was_open() {  # run_again_if_a_session_was_open <stdout file> <stderr file> <command...>
    local out=$1 err=$2 status=0
    shift 2
    for _ in 1 2 3 4 5; do
        status=0
        "$@" > "$out" 2> "$err" || status=$?
        if [ "$status" -eq 0 ] || ! grep -qF "$SESSION_REFUSAL" "$err"; then return "$status"; fi
        sleep 1
    done
    return "$status"
}
refused_by() {  # refused_by <message> <command...>: the command fails, says <message> and prints nothing on its standard output
    local message=$1
    shift
    if run_again_if_a_session_was_open "$work/refused.out" "$work/refused.err" "$@"; then fail "this must be refused ($message): $*"; fi
    [ ! -s "$work/refused.out" ] || fail "a refusal that printed on its standard output: $*"
    grep -qF -- "$message" "$work/refused.err" || { indented < "$work/refused.err" >&2; fail "refused, but not with: $message"; }
}
verified() { [ "$(scripts/postgres-roles.sh status)" = "postgres-roles: status: verified" ] || fail "status does not verify the roles"; }
committed() {  # committed [--adopt-table <name>...]: apply commits
    if ! run_again_if_a_session_was_open "$work/committed.out" "$work/committed.err" scripts/postgres-roles.sh apply "$@"; then
        indented < "$work/committed.err" >&2
        fail "apply did not commit"
    fi
    [ "$(cat "$work/committed.out")" = "postgres-roles: apply: committed" ] || fail "apply did not say it committed"
}

# The events of the containers of this project, in order, for the checks of what started when.
events_begin() {  # events_begin <name>
    sleep "${E2E_EVENTS_SETTLE:-1}"  # the events and the logs of an earlier command are not these (seconds)
    since_epoch=$(date +%s)
    docker events --since "$since_epoch" --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter type=container --format '{{json .}}' > "$work/events-$1.jsonl" &
    events_pid=$!
}
events_end() {
    [ -n "$events_pid" ] || return 0
    sleep "${E2E_EVENTS_SETTLE:-2}"  # what the daemon is still saying (seconds)
    kill "$events_pid" 2> /dev/null || true
    wait "$events_pid" 2> /dev/null || true
    events_pid=
}
ordered() {  # ordered <name> --expect <service:event>... [--absent <service:event>...]
    python3 .github/scripts/compose_e2e.py order "$work/events-$1.jsonl" "${@:2}"
}
start() {  # start <name> <ordered arguments>: docker compose up --wait, started in the order given
    local name=$1
    shift
    events_begin "$name"
    docker compose up --detach --wait --wait-timeout 180 || { events_end; fail "docker compose up did not complete: $name"; }
    events_end
    ordered "$name" "$@"
}
# What the web container is when a check of it fails: its networks (it needs default for the database and edge for
# the proxy), its state and health checks, and the end of its log.
describe_web() {
    local id
    id=$(container web)
    [ -n "$id" ] || { echo "web: no container" >&2; return 0; }
    {
        echo "web $id"
        docker inspect --format 'networks: {{range $name, $network := .NetworkSettings.Networks}}{{$name}} {{end}}' "$id"
        docker inspect --format 'state: {{.State.Status}}, restarts: {{.RestartCount}}, started: {{.State.StartedAt}}' "$id"
        docker inspect --format '{{if .State.Health}}health: {{.State.Health.Status}}{{range .State.Health.Log}}
  check at {{.Start}}: exit {{.ExitCode}} {{.Output}}{{end}}{{end}}' "$id"
        echo "log:"
        docker logs --tail 30 "$id" 2>&1 | indented
    } >&2 || true
}
recreate_web() {  # recreate_web <name>: web created again, by force, from the files as they are; started, and healthy
    events_begin "$1"
    docker compose up --detach --wait --wait-timeout 180 --no-deps --force-recreate web || { events_end; describe_web; fail "web did not start again: $1"; }
    events_end
    ordered "$1" --expect web:start web:healthy
}
refused_start() {  # refused_start <name> <seconds> <ordered arguments>: an up that cannot complete, and what it started
    local name=$1 seconds=$2
    shift 2
    events_begin "$name"
    if docker compose up --detach --wait --wait-timeout "$seconds" > "$work/up-$name.out" 2>&1; then
        events_end
        fail "the stack started, and must not have: $name"
    fi
    events_end
    ordered "$name" "$@"
}
# What Compose says of a wait that expires differs between its releases (an error, or none): when it is web that
# fails again and again, what happened to the containers is the answer, and the exit status of up is not looked at.
refused_web_start() {  # refused_web_start <name> <seconds> <message>: web, started by itself, is refused by its own check
    local name=$1 seconds=$2 restarts
    events_begin "$name"
    docker compose up --detach --no-deps --wait --wait-timeout "$seconds" web > "$work/up-$name.out" 2>&1 || true
    events_end
    ordered "$name" --expect web:start --absent web:healthy
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$(container web)")" != healthy ] || fail "web is healthy after a refusal: $name"
    restarts=$(docker inspect --format '{{.RestartCount}}' "$(container web)")
    [ "$restarts" -ge 1 ] || fail "web did not fail and start again: $name"
    grep -qF "$3" <<<"$(service_log web)" || { describe_web; fail "web did not say why: $3"; }
    docker compose stop web alert-engine
}
unapply_admin() {  # the migrations of the admin app undone by the migrate login, so that there is something to apply
    docker compose run --rm --no-deps -T migrate python manage.py migrate admin zero > "$work/unapply.out" 2>&1 \
        || { indented < "$work/unapply.out" >&2; fail "the migrations of admin could not be undone"; }
    expect "t" "the table of the undone migrations" "SELECT to_regclass('public.django_admin_log') IS NULL"
}
admin_stays_unapplied() {  # admin_stays_unapplied <what ran>: no migration ran in it
    expect "t" "django_admin_log after $1" "SELECT to_regclass('public.django_admin_log') IS NULL"
    expect "0" "the record of the migrations of admin after $1" "SELECT count(*) FROM django_migrations WHERE app = 'admin'"
}

# What PostgreSQL says to statements run with the login of a container: one line each.
probe() {  # probe <web|migrate> <statements, one a line>
    case "$1" in
        web) docker compose exec -T --env "WEB_SQL=$2" web python manage.py shell --no-imports -v 0 -c "$(cat .github/scripts/sql_probe.py)" < /dev/null ;;
        migrate) docker compose run --rm --no-deps -T -e "WEB_SQL=$2" migrate python manage.py shell --no-imports -v 0 -c "$(cat .github/scripts/sql_probe.py)" < /dev/null ;;
        *) fail "probe: unknown service $1" ;;
    esac
}
web_sql() {  # web_sql <statement>: run as the application, print the first column
    # The statement reaches .github/scripts/web_sql.py as data, in its environment.
    docker compose exec -T --env "WEB_SQL=$1" web python manage.py shell --no-imports -v 0 \
        -c "$(cat .github/scripts/web_sql.py)"
}
refused() {  # refused <web|migrate> <statement>...: PostgreSQL refuses each one (42501, insufficient privilege)
    local service=$1 got expected
    shift
    got=$(probe "$service" "$(printf '%s\n' "$@")")
    expected=$(printf 'error 42501\n%.0s' "$@")
    [ "$got" = "$expected" ] || { indented <<<"$got" >&2; fail "$service was not refused every one of: $*"; }
}

allowed() {  # the runtime login does what it is for, and PostgreSQL says so
    local index
    for ((index = 0; index < ${#WEB_ALLOWED[@]}; index += 2)); do
        [ "$(probe web "${WEB_ALLOWED[index]}")" = "${WEB_ALLOWED[index + 1]}" ] || fail "web cannot: ${WEB_ALLOWED[index]}"
    done
}

# What the processes of a container hold, a block for each: "## <pid> <command line>", then its environment.
# shellcheck disable=SC2016
PROCESS_DUMP='for p in /proc/[0-9]*; do printf "## %s " "${p#/proc/}"; tr "\0" " " < "$p/cmdline" 2> /dev/null; printf "\n"; tr "\0" "\n" < "$p/environ" 2> /dev/null; printf "\n"; done; true'
# What every container holds: its environment as Docker made it, the environment and the command line of
# its processes (the database's read as the user it runs as: another user's are not readable), what the
# image holds of the environment files, its mounts and the log.
check_isolation() {  # check_isolation <name>
    local dir="$work/evidence-$1" service id
    mkdir -p "$dir"
    for service in web migrate db alert-engine proxy; do
        id=$(container "$service")
        [ -n "$id" ] || fail "no $service container"
        docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" > "$dir/$service.env"
        docker inspect --format '{{json .Mounts}}' "$id" > "$dir/$service.mounts"
    done
    docker compose exec -T web sh -c "$PROCESS_DUMP" > "$dir/web.processes"
    docker compose exec -T -u postgres db sh -c "$PROCESS_DUMP" > "$dir/db.processes"
    docker compose exec -T web sh -c 'find /app -name ".env*" -o -name "*.env" 2> /dev/null; find / -maxdepth 1 -name ".env*" -o -name "*.env" 2> /dev/null; true' > "$dir/web.files"
    docker compose logs --no-color > "$dir/logs" 2>&1
    write_secrets
    python3 .github/scripts/compose_e2e.py isolation "$dir" --secrets "$work/secrets.json" || fail "a container holds a secret that is not its own ($1)"
}

# --- the files of the installation

separate_layout() {  # .env moved as docs/server-deployment.md describes, with $app and $migration
    (
        umask 077
        grep '^POSTGRES_PASSWORD=' .env > .env.bootstrap
        printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$migration" > .env.migrate
    )
    sed -i '/^POSTGRES_PASSWORD=/d' .env
    printf 'SENTINEL_DB_ROLES=separate\nSENTINEL_DB_PASSWORD=%s\nSENTINEL_BOOTSTRAP_ENV_FILE=.env.bootstrap\nSENTINEL_MIGRATE_ENV_FILE=.env.migrate\n' \
        "$app" >> .env
}

# ============================================================================================
# An existing installation: one superuser login, moved to the separate logins
# ============================================================================================

scenario_existing_installation() {
    # Checks: the stack starts cold in order (database healthy before migrate starts, migrate
    # ended before web starts, web healthy) on the PostgreSQL version asked for, and its tables
    # belong to the one superuser login.
    local major version image
    start cold-start --expect db:start db:healthy migrate:start migrate:die=0 web:start web:healthy
    major=$(echo "SELECT current_setting('server_version_num')::int / 10000" | sql)
    version=$(echo "SHOW server_version" | sql)
    image=$(docker inspect --format '{{.Config.Image}}' "$(container db)")
    [ "$major" = "$postgres" ] || fail "the db service runs PostgreSQL $major, not $postgres"
    [ "$image" = "postgres:$postgres-alpine" ] || fail "the db service runs the image $image"
    echo "E2E server $version ($image)"
    [ "$(table_owners)" = "$(value_of POSTGRES_USER)" ] || fail "the tables belong to: $(table_owners)"
    bootstrap=$(value_of POSTGRES_PASSWORD)
    [ -n "$bootstrap" ] || fail "no POSTGRES_PASSWORD in .env"
    mask "$bootstrap"
    db_hash=$(docker compose config --hash db)
}

scenario_move_credentials() {
    # Checks: the bootstrap password moves out of .env without changing the db service, and the
    # resolved configuration gives each service its own secrets only, with the shell of the
    # operator holding all three (nothing in the shell reaches web or migrate).
    docker compose stop web alert-engine
    new_secret app
    new_secret migration
    separate_layout
    cp .env "$work/env.separate"
    [ "$(docker compose config --hash db)" = "$db_hash" ] || fail "moving the password changes the db service"
    write_secrets
    POSTGRES_PASSWORD=$bootstrap SENTINEL_DB_PASSWORD=$app SENTINEL_DB_MIGRATE_PASSWORD=$migration \
        docker compose config --format json | python3 .github/scripts/compose_e2e.py config --secrets "$work/secrets.json" \
        || fail "Compose gives a service a secret that is not its own"
}

scenario_provisioning_refusals() {
    # Checks: apply refuses, naming what to revoke, until the operator has taken TEMPORARY,
    # CONNECT elsewhere and large-object creation from PUBLIC, each in turn; then until the
    # tables of the existing installation are named. Nothing is committed by a refusal.
    local database
    database=$(value_of POSTGRES_DB)
    refused_by "REVOKE TEMPORARY ON DATABASE" scripts/postgres-roles.sh apply
    grep -q 'postgres-roles: nothing was committed' "$work/refused.err" || fail "apply did not say that nothing was committed"
    sql > "$work/public-grants.sql" <<'SQL'
SELECT format('GRANT %s ON DATABASE %I TO PUBLIC;', privilege, datname)
  FROM pg_database, unnest(ARRAY['CONNECT', 'TEMPORARY']) privilege
 WHERE datallowconn AND has_database_privilege('public', oid, privilege);
SELECT format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC;', oid::regprocedure)
  FROM pg_proc WHERE prosrc IN ('be_lo_creat', 'be_lo_create', 'be_lo_from_bytea')
   AND has_function_privilege('public', oid, 'EXECUTE');
SQL
    grep -q '^GRANT CONNECT ON DATABASE postgres TO PUBLIC;$' "$work/public-grants.sql" \
        || fail "nothing recorded of what PUBLIC holds"
    grep -q '^GRANT EXECUTE ON FUNCTION lo_create(oid) TO PUBLIC;$' "$work/public-grants.sql" \
        || fail "nothing recorded of what PUBLIC holds on large objects"
    sql <<'SQL'
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database WHERE datallowconn \gexec
SQL
    refused_by "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC" scripts/postgres-roles.sh apply
    sql <<'SQL'
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database WHERE datallowconn AND datname <> current_database() \gexec
SQL
    refused_by "the managed roles could create large objects" scripts/postgres-roles.sh apply
    sql <<'SQL'
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),
    pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;
SQL
    refused_by "relations in schema public belong to the bootstrap superuser" scripts/postgres-roles.sh apply
    mapfile -t adopt < <(grep -o -- '--adopt-table [a-z0-9_]*' "$work/refused.err" | tr ' ' '\n')
    [ "${#adopt[@]}" -gt 0 ] || { cat "$work/refused.err" >&2; fail "apply did not list the tables"; }
    [ "$(managed_roles)" = 0 ] && [ "$(marker)" = 0 ] || fail "a refused apply left something behind"
    expect "t" "PUBLIC still connects to Sentinel's database" \
        "SELECT has_database_privilege('public', '$database', 'CONNECT')"
}

scenario_interrupted_provisioning() {
    # Checks: the database server is killed while apply is inside its transaction, after the
    # tables have changed hands. Nothing was committed: no role, no record, the tables still
    # belong to the bootstrap superuser, and every privilege is as it was. (The stack is down.)
    local before owners attempt
    before=$(fingerprint)
    owners=$(table_owners)
    docker compose config --format json \
        | python3 -m sentinel.db_roles apply --compose-config - --nonce "$(nonce)" "${adopt[@]}" \
        | hold_provisioning > "$work/held.sql"
    for attempt in 1 2 3; do
        docker compose exec -T db sh -c 'exec psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' \
            < "$work/held.sql" > "$work/held.out" 2>&1 &
        client=$!
        retry 60 "apply to reach its wait, or to end" held_or_ended || { indented < "$work/held.out" >&2; exit 1; }
        if holds_provisioning; then break; fi
        wait "$client" || true  # it ended: refused because the health check had a session open, or for another reason
        if ! grep -qF "$SESSION_REFUSAL" "$work/held.out" || [ "$attempt" -eq 3 ]; then
            indented < "$work/held.out" >&2
            fail "apply did not reach its wait"
        fi
    done
    [ "$(managed_roles)" = 0 ] && [ "$(table_owners)" = "$owners" ] || fail "a transaction that did not commit is visible"
    docker compose kill db
    wait "$client" || true  # the client lost its server
    # Docker does not start a container again that was killed (it counts as a stop): the same container
    # starts, finds the cluster as the kill left it, and recovers it.
    docker compose stop --timeout 30 db
    docker compose up --detach --wait --wait-timeout 180 db
    ! grep -q 'sentinel-roles: committed' "$work/held.out" || fail "the interrupted program reported a commit"
    [ "$(managed_roles)" = 0 ] || fail "the roles exist after an interrupted provisioning"
    [ "$(marker)" = 0 ] || fail "the activation record exists after an interrupted provisioning"
    [ "$(table_owners)" = "$owners" ] || fail "the tables changed hands without a commit: $(table_owners)"
    [ "$(fingerprint)" = "$before" ] || fail "an interrupted provisioning changed a privilege"
}
held_or_ended() { holds_provisioning || ! kill -0 "$client" 2> /dev/null; }

scenario_activation_with_adoption() {
    # Checks: apply, given the tables, commits; they belong to the owner role; the activation
    # record exists and status verifies it.
    committed "${adopt[@]}"
    expect "sentinel_owner" "the tables belong to" "SELECT string_agg(DISTINCT pg_get_userbyid(relowner), ',') FROM pg_class WHERE relnamespace = 'public'::regnamespace"
    [ "$(marker)" = 1 ] || fail "no activation record"
    [ "$(managed_roles)" = 3 ] || fail "the three roles do not exist"
    verified
}

scenario_start_and_verify() {
    # Checks: migrate applies the migrations and verifies, then web verifies and starts, in order;
    # web runs as the runtime login, which reads django_migrations and changes nothing in it,
    # while the application's own rows are its to change.
    start provisioned --expect migrate:start migrate:die=0 web:start web:healthy
    [ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$(container migrate)")" = "exited 0" ] \
        || fail "the migrate service did not exit 0"
    grep -q 'entrypoint: verifying the privileges of the runtime login' <<<"$(migrate_log)" || fail "migrate did not verify"
    grep -q 'entrypoint: verifying the privileges of the runtime login' <<<"$(docker compose logs web 2>&1)" || fail "web did not verify"
    [ "$(table_owners)" = sentinel_owner ] || fail "schema objects are owned by: $(table_owners)"
    [ "$(web_sql 'SELECT current_user')" = sentinel_app ] || fail "web does not run as sentinel_app"
    [ "$(migrations_privileges)" = "app SELECT" ] || fail "the runtime login or PUBLIC may do more than read django_migrations: $(migrations_privileges)"
    refused web "${RECORD_WRITES[@]}"
    allowed
    docker compose exec -T web python manage.py migrate --check
    verified
}

scenario_credential_isolation() {
    # Checks: each container holds its own secrets only, as Docker made its environment and as its
    # processes see it, on no command line, in no log, in no file of the image and no mount. Then
    # the accident: the migration password left in .env reaches web blank. Compose does not create
    # a service again whose resolved configuration is the same (the blank `environment` of web
    # beats .env), so web is created again by force, from the files as they are.
    check_isolation separate
    printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$migration" >> .env
    docker compose config --format json | python3 .github/scripts/compose_e2e.py config --secrets "$work/secrets.json" \
        || fail "Compose gives a service a secret that is not its own, with a password left in .env"
    recreate_web accident
    check_isolation accident
    cp "$work/env.separate" .env
    recreate_web restored
}

scenario_runtime_restrictions() {
    # Checks: neither login can change what the roles are: not the schema, the roles, the
    # record of the activation; neither can create a temporary table or a large object; and
    # what the runtime login is for stays allowed.
    refused web "${WEB_REFUSED[@]}"
    refused migrate "${MIGRATE_REFUSED[@]}"
    allowed
}

scenario_bootstrap_password_refused() {
    # Checks: the bootstrap password put back into .env stops the deployment: migrate refuses it
    # and web is not started. (Compose creates web again before it starts anything, so the
    # running web is replaced by a container that is never started, with the password in its
    # configuration: no container that runs holds it.)
    local id state env
    cat .env.bootstrap >> .env
    refused_start bootstrap 90 --expect migrate:start migrate:die --absent web:start
    grep -q 'POSTGRES_PASSWORD is set, but with SENTINEL_DB_ROLES=separate' <<<"$(migrate_log)" \
        || fail "migrate did not refuse the bootstrap password"
    id=$(container web)
    if [ -n "$id" ]; then
        state=$(docker inspect --format '{{.State.Status}}' "$id")
        env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id")
        if [ "$state" = running ] && grep -q '^POSTGRES_PASSWORD=.' <<<"$env"; then fail "web runs with the bootstrap password"; fi
    fi
    cp "$work/env.separate" .env
}

scenario_legacy_settings_refused() {
    # Checks: once the roles are activated, the installation cannot go back to the superuser login
    # by its old .env: web is refused at its first connection, before it applies anything (the
    # migrations of an app were undone first: they would be applied again if it got further).
    local applied restarts
    docker compose stop web alert-engine
    unapply_admin
    applied=$(applied_migrations)
    grep -v -e '^SENTINEL_DB_ROLES=' -e '^SENTINEL_DB_PASSWORD=' -e '^SENTINEL_BOOTSTRAP_ENV_FILE=' \
        -e '^SENTINEL_MIGRATE_ENV_FILE=' "$work/env.separate" > .env
    cat .env.bootstrap >> .env
    # web fails and starts again and again: it is judged by what happened to it, not by what up says.
    events_begin legacy
    docker compose up --detach --wait --wait-timeout 60 > "$work/up-legacy.out" 2>&1 || true
    events_end
    ordered legacy --expect migrate:start migrate:die=0 web:start --absent web:healthy
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$(container web)")" != healthy ] || fail "web is healthy with the superuser login"
    restarts=$(docker inspect --format '{{.RestartCount}}' "$(container web)")
    [ "$restarts" -ge 1 ] || fail "web did not fail and start again"
    grep -q 'a superuser login, may not be used' <<<"$(service_log web)" || fail "web was not refused as a superuser login"
    admin_stays_unapplied "a refused superuser login"
    [ "$(applied_migrations)" = "$applied" ] || fail "a refused superuser login changed the record of the migrations"
    if curl --fail --silent --max-time 3 --output /dev/null http://127.0.0.1:8000/health/; then fail "web serves with the superuser login"; fi
    docker compose stop web alert-engine
    cp "$work/env.separate" .env
    # The migrate service as it always runs: what was undone is applied again.
    docker compose run --rm --no-deps -T migrate > "$work/reapply.out" 2>&1 || { indented < "$work/reapply.out" >&2; fail "the migrations of admin could not be applied again"; }
    expect "t" "the migrations of admin applied again" "SELECT to_regclass('public.django_admin_log') IS NOT NULL"
}

scenario_second_start() {
    # Checks: nothing to apply on a second start, and the running stack is what check-server.sh
    # expects of one.
    start second --expect migrate:start migrate:die=0 web:start web:healthy
    grep -q 'No migrations to apply' <<<"$(migrate_log)" || fail "migrate did not run again"
    .github/scripts/check-server.sh
}

# ============================================================================================
# A new installation: the logins first, then the first migration
# ============================================================================================

scenario_not_started_before_provisioning() {
    # Checks: on a new database, before the logins exist, the deployment fails at migrate (it
    # cannot log in) after the database was healthy, and web is never started; nothing is created.
    docker compose down --volumes --remove-orphans
    retired+=("$app" "$migration")
    cp "$work/env.initial" .env
    rm -f .env.bootstrap .env.migrate
    new_secret app
    new_secret migration
    separate_layout
    scripts/postgres-preflight.sh
    refused_start unprovisioned 90 --expect db:start db:healthy migrate:start migrate:die=1 --absent web:start
    grep -q 'authentication failed' <<<"$(migrate_log)" || fail "migrate was not refused at its login"
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$(container db)")" = healthy ] || fail "the database is not healthy"
    [ "$(managed_roles)" = 0 ] && [ "$(marker)" = 0 ] || fail "a deployment before the provisioning created roles"
    expect "0" "tables of a deployment that never migrated" "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace"
}

scenario_lost_acknowledgement() {
    # Checks: apply commits but its confirmation is lost: the script says so (the database is
    # provisioned), and does not claim a failure to commit; status verifies; apply again, as it
    # says, only sets the passwords.
    revoke_public
    lose_acknowledgement "$work/shim"
    if PATH="$work/shim:$PATH" run_again_if_a_session_was_open "$work/lost.out" "$work/apply" scripts/postgres-roles.sh apply; then
        fail "apply reported success without its acknowledgement"
    fi
    grep -q 'postgres-roles: apply did not finish' "$work/apply" || fail "apply did not say it did not finish"
    grep -q 'postgres-roles: the database is provisioned (schema sentinel_restricted exists)' "$work/apply" \
        || { indented < "$work/apply" >&2; fail "apply did not say that the database is provisioned"; }
    if grep -q 'nothing was committed' "$work/apply"; then fail "apply said nothing was committed, and it was"; fi
    [ "$(managed_roles)" = 3 ] && [ "$(marker)" = 1 ] || fail "the provisioning did not commit"
    verified
    committed
}

scenario_first_migration() {
    # Checks: the migrate login creates every table, as the owner role, django_migrations
    # included: the runtime login reads it and nothing else does anything; the stack then
    # starts in order, web as the runtime login.
    start first --expect migrate:start migrate:die=0 web:start web:healthy
    [ "$(table_owners)" = sentinel_owner ] || fail "schema objects are owned by: $(table_owners)"
    [ "$(migrations_privileges)" = "app SELECT" ] || fail "django_migrations is not read-only for the runtime login: $(migrations_privileges)"
    [ "$(web_sql 'SELECT current_user')" = sentinel_app ] || fail "web does not run as sentinel_app"
    refused web "${RECORD_WRITES[@]}"
    docker compose exec -T web python manage.py migrate --check
    verified
}

scenario_state_b_reapplication() {
    # Checks: apply on an activated installation changes the passwords and nothing else (new
    # salts, the same privileges), and refuses to adopt tables: there is nothing to adopt.
    local before verifiers_before after
    before=$(fingerprint)
    verifiers_before=$(verifiers)
    committed
    [ "$(fingerprint)" = "$before" ] || fail "reapplying changed a privilege"
    after=$(verifiers)
    [ "$after" != "$verifiers_before" ] || fail "reapplying did not set the passwords"
    [ "$(grep -c '^sentinel_owner none$' <<<"$after")" = 1 ] || fail "the owner role has a password"
    refused_by "activated already (state B)" scripts/postgres-roles.sh apply --adopt-table auth_group
    [ "$(verifiers)" = "$after" ] && [ "$(fingerprint)" = "$before" ] || fail "a refused apply changed something"
    [ "$(web_sql 'SELECT current_user')" = sentinel_app ] || fail "web no longer runs as the runtime login"
}

scenario_activation_marker() {
    # Checks: the record of the activation belongs to the bootstrap superuser, is open to no one,
    # and names this database and these roles; neither login can drop or change it; one that is
    # changed or missing, or a role that is missing, makes the installation state C, which status
    # and every start refuse. (apply refuses a renamed role earlier, as a role that is not
    # Sentinel's: the topology check comes first.)
    local record
    expect "t" "the record belongs to the bootstrap superuser" \
        "SELECT nspowner = 10 AND (nspacl IS NULL OR nspacl::text = ('{' || pg_get_userbyid(10) || '=UC/' || pg_get_userbyid(10) || '}')) FROM pg_namespace WHERE nspname = 'sentinel_restricted'"
    expect "t" "the record names this database and these roles" \
        "SELECT obj_description(oid, 'pg_namespace') ~ '^sentinel-roles activation 1: database=[0-9]+ owner=[0-9]+ migrate=[0-9]+ app=[0-9]+\$' FROM pg_namespace WHERE nspname = 'sentinel_restricted'"
    refused web "${MARKER_REFUSED_WEB[@]}"
    refused migrate "${MARKER_REFUSED_MIGRATE[@]}"
    record=$(echo "SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname = 'sentinel_restricted'" | sql)
    docker compose stop web alert-engine
    # The record changed.
    echo "COMMENT ON SCHEMA sentinel_restricted IS 'e2e altered'" | sql
    refused_by "state C" scripts/postgres-roles.sh status
    refused_by "state C" scripts/postgres-roles.sh apply
    refused_start altered 90 --expect migrate:start migrate:die=1 --absent web:start
    grep -q 'state C' <<<"$(migrate_log)" || fail "migrate did not refuse a changed record"
    echo "COMMENT ON SCHEMA sentinel_restricted IS '$record'" | sql
    verified
    # The record missing, the roles still there.
    echo "DROP SCHEMA sentinel_restricted" | sql
    refused_by "state C" scripts/postgres-roles.sh status
    refused_by "state C" scripts/postgres-roles.sh apply
    refused_start missing 90 --expect migrate:start migrate:die=1 --absent web:start
    grep -q 'state C' <<<"$(migrate_log)" || fail "migrate did not refuse a missing record"
    printf "CREATE SCHEMA sentinel_restricted;\nCOMMENT ON SCHEMA sentinel_restricted IS '%s';\n" "$record" | sql
    verified
    # A role missing, the record still there.
    echo "ALTER ROLE sentinel_app RENAME TO sentinel_app_gone" | sql_cluster
    refused_by "state C" scripts/postgres-roles.sh status
    refused_by "$RENAMED_ROLE_REFUSAL" scripts/postgres-roles.sh apply
    refused_start renamed 90 --expect migrate:start migrate:die=1 --absent web:start
    grep -q 'state C' <<<"$(migrate_log)" || fail "migrate did not refuse a missing role"
    echo "ALTER ROLE sentinel_app_gone RENAME TO sentinel_app" | sql_cluster
    verified
    start recovered --expect migrate:start migrate:die=0 web:start web:healthy
}

scenario_privilege_drift() {
    # Checks: what an administrator could change that gives the roles more than Sentinel
    # provisions (a privilege, CREATE on the database, TEMPORARY or large objects for PUBLIC,
    # and writes to the record of the migrations, which is the roles' central invariant) is found
    # by status and refused by apply, by the migrate service and by web started by itself; the
    # deployment starts nothing and runs no migration (the migrations of an app were undone
    # first: they would be applied if one ran), and changes nothing; undone, everything is
    # accepted again, as it was.
    local database before verifiers_before applied variant name change undo expectation first=true
    database=$(value_of POSTGRES_DB)
    docker compose stop web alert-engine
    unapply_admin
    before=$(fingerprint)
    verifiers_before=$(verifiers)
    applied=$(applied_migrations)
    for variant in \
        "migrations-insert|GRANT INSERT ON django_migrations TO sentinel_app|REVOKE INSERT ON django_migrations FROM sentinel_app|the runtime role has INSERT on django_migrations" \
        "migrations-column-public|GRANT UPDATE (name) ON django_migrations TO PUBLIC|REVOKE UPDATE (name) ON django_migrations FROM PUBLIC|the runtime role has UPDATE on django_migrations" \
        "migrations-truncate|GRANT TRUNCATE ON django_migrations TO sentinel_app|REVOKE TRUNCATE ON django_migrations FROM sentinel_app|the runtime role has TRUNCATE on django_migrations" \
        "runtime-privilege|GRANT TRUNCATE ON auth_group TO sentinel_app|REVOKE TRUNCATE ON auth_group FROM sentinel_app|the runtime role has TRUNCATE on auth_group" \
        "database-create|GRANT CREATE ON DATABASE $database TO sentinel_app|REVOKE CREATE ON DATABASE $database FROM sentinel_app|may create schemas in database(s)" \
        "public-temporary|GRANT TEMPORARY ON DATABASE $database TO PUBLIC|REVOKE TEMPORARY ON DATABASE $database FROM PUBLIC|REVOKE TEMPORARY ON DATABASE" \
        "public-large-objects|GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO PUBLIC|REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM PUBLIC|the managed roles could create large objects"
    do
        IFS='|' read -r name change undo expectation <<<"$variant"
        echo "-- $name"
        echo "$change" | sql
        refused_by "$expectation" scripts/postgres-roles.sh status
        refused_by "$expectation" scripts/postgres-roles.sh apply
        [ "$(verifiers)" = "$verifiers_before" ] || fail "a refused apply changed the passwords ($name)"
        refused_start "drift-$name" 90 --expect migrate:start migrate:die=1 --absent web:start
        grep -qF "the database roles differ from what Sentinel provisions" <<<"$(migrate_log)" || fail "migrate did not say why ($name)"
        grep -qF "$expectation" <<<"$(migrate_log)" || fail "migrate did not name the difference ($name)"
        admin_stays_unapplied "$name"
        [ "$(applied_migrations)" = "$applied" ] || fail "a migration ran with the roles drifted ($name)"
        # Web, started by itself, makes its own check: it is refused too, and fails again and again.
        if [ "$first" = true ]; then
            refused_web_start "drift-web-$name" 40 "$expectation"
            first=false
        fi
        echo "$undo" | sql
        [ "$(fingerprint)" = "$before" ] || fail "undoing the change did not restore every privilege ($name)"
        verified
    done
    start undone --expect migrate:start migrate:die=0 web:start web:healthy
    expect "t" "the migrations that were undone, applied by the deployment that follows" "SELECT to_regclass('public.django_admin_log') IS NOT NULL"
}

scenario_password_rotation() {
    # Checks: new passwords in .env and .env.migrate, web stopped, apply: the new ones log in,
    # the old ones no longer do, no privilege changed, and the retired passwords are nowhere in
    # the stack, as it runs again.
    local before old_app old_migration verifiers_before after role
    verifiers_before=$(verifiers)
    old_app=$app
    old_migration=$migration
    retired+=("$old_app" "$old_migration")
    new_secret app
    new_secret migration
    sed -i "s|^SENTINEL_DB_PASSWORD=.*|SENTINEL_DB_PASSWORD=$app|" .env
    printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$migration" > .env.migrate
    cp .env "$work/env.separate"
    docker compose stop web alert-engine
    before=$(fingerprint)
    committed
    [ "$(fingerprint)" = "$before" ] || fail "rotating the passwords changed a privilege"
    after=$(verifiers)
    for role in sentinel_app sentinel_migrate; do
        [ "$(grep "^$role " <<<"$after")" != "$(grep "^$role " <<<"$verifiers_before")" ] || fail "the password of $role was not changed"
    done
    # The old passwords, offered by one-off containers, whose environment says so.
    if docker compose run --rm --no-deps -T -e "SENTINEL_DB_PASSWORD=$old_app" web true > "$work/old-runtime.out" 2>&1; then
        fail "the old runtime password still logs in"
    fi
    grep -q 'authentication failed' "$work/old-runtime.out" || fail "the old runtime password was not refused as a password"
    if docker compose run --rm --no-deps -T -e "SENTINEL_DB_MIGRATE_PASSWORD=$old_migration" migrate > "$work/old-migration.out" 2>&1; then
        fail "the old migration password still logs in"
    fi
    grep -q 'authentication failed' "$work/old-migration.out" || fail "the old migration password was not refused as a password"
    start rotated --expect migrate:start migrate:die=0 web:start web:healthy
    [ "$(web_sql 'SELECT current_user')" = sentinel_app ] || fail "web does not run as the runtime login with its new password"
    check_isolation rotated
}

scenario_interrupted_migration() {
    # Checks: migrate is killed while its migration is inside a transaction, waiting for a lock
    # (the migrations of an app are undone first, so there is something to apply). The deployment
    # fails and never starts web; the migration that was in flight left nothing behind, nothing
    # was weakened; the next start finishes the job.
    local before up
    docker compose stop web alert-engine
    unapply_admin
    before=$(fingerprint)
    # A superuser session holds a lock that the creation of django_admin_log's foreign key needs.
    docker compose exec -T -d -e PGAPPNAME=e2e-lock db sh -c \
        'exec psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "BEGIN; LOCK TABLE django_content_type IN ACCESS EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(600); COMMIT;"'
    retry 30 "the lock to be held" lock_held || exit 1
    events_begin interrupted
    docker compose up --detach --wait --wait-timeout 180 > "$work/up-interrupted.out" 2>&1 &
    up=$!
    retry 90 "the migration to wait for the lock" migration_blocked || { events_end; exit 1; }
    docker compose kill migrate
    if wait "$up"; then events_end; fail "the deployment completed although migrate was killed"; fi
    echo "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'e2e-lock'" | sql_cluster > /dev/null
    retry 30 "the lock to be released" lock_released || { events_end; exit 1; }
    events_end
    ordered interrupted --expect migrate:start migrate:die=137 --absent web:start
    [ "$(docker inspect --format '{{.State.Running}}' "$(container migrate)")" = false ] || fail "migrate is still running"
    expect "t" "the interrupted migration's table" "SELECT to_regclass('public.django_admin_log') IS NULL"
    expect "0" "the interrupted migration's record" "SELECT count(*) FROM django_migrations WHERE app = 'admin'"
    [ "$(fingerprint)" = "$before" ] || fail "an interrupted migration changed a privilege"
    [ "$(migrations_privileges)" = "app SELECT" ] || fail "an interrupted migration left django_migrations writable"
    verified
    start resumed --expect migrate:start migrate:die=0 web:start web:healthy
    expect "t" "the migrations finished" "SELECT to_regclass('public.django_admin_log') IS NOT NULL"
    expect "sentinel_owner" "the owner of what was migrated again" "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.django_admin_log'::regclass"
    [ "$(migrations_privileges)" = "app SELECT" ] || fail "django_migrations is not read-only for the runtime login after the interruption"
    docker compose exec -T web python manage.py migrate --check
}
lock_held() {
    [ "$(echo "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.mode = 'AccessExclusiveLock' AND l.granted AND c.relname = 'django_content_type'" | sql)" = 1 ]
}
migration_blocked() {  # the migrate login waits for the share row exclusive lock that the foreign key to django_content_type needs
    [ "$(echo "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND l.mode = 'ShareRowExclusiveLock' AND c.relname = 'django_content_type' AND a.usename = 'sentinel_migrate'" | sql)" -ge 1 ]
}
lock_released() {
    [ "$(echo "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'e2e-lock' OR usename = 'sentinel_migrate'" | sql_cluster)" = 0 ]
}

scenario_failed_deployment_restart() {
    # Checks: a deployment that fails (a wrong migration password) starts nothing and changes no
    # privilege; once corrected, the same command completes it; the last state of the stack holds
    # each secret in its own container only, the wrong password in none.
    local before wrong
    docker compose stop web alert-engine
    before=$(fingerprint)
    cp .env.migrate "$work/env.migrate.good"
    new_secret wrong
    retired+=("$wrong")
    printf 'SENTINEL_DB_MIGRATE_PASSWORD=%s\n' "$wrong" > .env.migrate
    refused_start failed 90 --expect migrate:start migrate:die=1 --absent web:start
    grep -q 'authentication failed' <<<"$(migrate_log)" || fail "migrate was not refused at its login"
    [ "$(fingerprint)" = "$before" ] || fail "a failed deployment changed a privilege"
    cp "$work/env.migrate.good" .env.migrate
    start corrected --expect migrate:start migrate:die=0 web:start web:healthy
    [ "$(fingerprint)" = "$before" ] || fail "the corrected deployment changed a privilege"
    verified
    check_isolation final
}

# ============================================================================================

SCENARIOS=(
    existing-installation move-credentials provisioning-refusals interrupted-provisioning
    activation-with-adoption start-and-verify credential-isolation runtime-restrictions
    bootstrap-password-refused legacy-settings-refused second-start
    not-started-before-provisioning lost-acknowledgement first-migration state-b-reapplication
    activation-marker privilege-drift password-rotation interrupted-migration failed-deployment-restart
)

cleanup() {
    events_end
    if [ -n "$work" ]; then rm -rf "$work"; fi
}

main() {
    postgres=${SENTINEL_E2E_POSTGRES:-}
    case "$postgres" in 16 | 18) ;; *) fail "SENTINEL_E2E_POSTGRES must be 16 or 18" ;; esac
    : "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME names the Compose project this script owns}"
    if [ "$postgres" = 18 ]; then
        grep -qx 'SENTINEL_POSTGRES=18' .env || fail "PostgreSQL 18 is not selected in .env: run ci-env.sh 18 first"
        grep -qx 'SENTINEL_POSTGRES_INITIALIZE=true' .env || fail "the first start is not authorized in .env: run ci-env.sh 18 first"
    else
        if grep -q '^SENTINEL_POSTGRES=' .env; then fail "an installation on PostgreSQL 16 selects no version: run ci-env.sh 16"; fi
    fi
    [ ! -e .env.migrate ] && [ ! -e .env.bootstrap ] || fail ".env.migrate or .env.bootstrap exists"
    [ -z "$(docker compose ps --all --quiet)" ] || fail "the Compose project $COMPOSE_PROJECT_NAME has containers already"
    [ -z "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ] \
        || fail "the Compose project $COMPOSE_PROJECT_NAME has volumes already"
    work=$(mktemp -d)
    trap cleanup EXIT
    cp .env "$work/env.initial"
    E2E_REAL_DOCKER=$(command -v docker)
    export E2E_REAL_DOCKER

    local compose name count=0
    compose=$(docker compose version --short)
    echo "E2E compose=${compose#v} postgres=$postgres"
    echo "E2E scenarios: ${SCENARIOS[*]}"
    for name in "${SCENARIOS[@]}"; do
        step "$name"
        "scenario_${name//-/_}"
        echo "SCENARIO PASS $name"
        count=$((count + 1))
    done
    [ "$count" -eq "${#SCENARIOS[@]}" ] || fail "only $count of ${#SCENARIOS[@]} scenarios ran"
    echo "E2E RESULT: passed $count of ${#SCENARIOS[@]}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
