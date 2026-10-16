#!/usr/bin/env bash
# Provisions the separate database logins of SENTINEL_DB_ROLES=separate
# (apply) or checks them (status), as the operator, with the passwords Docker
# Compose gives to the web and migrate services:
#
#   scripts/postgres-roles.sh apply [--adopt-table NAME ...]
#   scripts/postgres-roles.sh status
#
# Run it from the project directory, with the environment you run
# `docker compose` with, while the db service runs: stop web first, since
# apply refuses while a Sentinel process is connected as the superuser. It
# needs python3 on the host. sentinel/db_roles.py writes the program, which
# psql runs in the db container as the bootstrap superuser, over the
# container's own socket: no password is needed for that, and the bootstrap
# superuser's password is never read. The passwords of the separate logins go
# from `docker compose config` to the program through pipes only (never the
# command line, the environment of another process or a file), and travel
# as SCRAM verifiers from there. Nothing secret is printed.
#
# Exit status: 0 provisioned (apply) or verified (status); 1 refused or
# failed; 2 usage. apply is one transaction: when it does not confirm its
# commit, either nothing changed (it refused, or stopped before COMMIT) or,
# if the connection broke at its very end, all of it did. It then says which:
# the schema sentinel_restricted exists only once some apply has committed.
# Running apply again is safe either way: from an activated installation, as
# apply left it, it only sets the passwords; it refuses, and changes
# nothing, anywhere else.
set -euo pipefail

usage() {
    sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
}

command=${1:-}
case "$command" in
    apply) last="committed" ;;
    status) last="verified" ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
esac
shift

root=$(cd "$(dirname "$0")/.." && pwd)
nonce=$(python3 -c 'import secrets; print(secrets.token_hex(16))')

# The resolved configuration holds every password of the stack: it stays in
# this shell's memory and goes to the generator on its standard input.
if ! config=$(docker compose config --format json); then
    echo "postgres-roles: docker compose cannot resolve the configuration" >&2
    exit 1
fi

# psql reports success even when its program stops early, and gets an empty
# program when the generator refuses: only the last line, with this run's
# nonce, says the program ran to its end.
if output=$(printf '%s' "$config" |
    PYTHONPATH="$root" python3 -m sentinel.db_roles "$command" --compose-config - --nonce "$nonce" "$@" |
    docker compose exec -T db sh -c 'exec psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -'); then
    status=0
else
    status=$?
fi
unset config
if [ "$status" -eq 0 ] && [ "$(printf '%s\n' "$output" | tail -n 1)" = "sentinel-roles: $last $nonce" ]; then
    echo "postgres-roles: $command: $last"
    exit 0
fi
echo "postgres-roles: $command did not finish (status $status); see the messages above" >&2
if [ "$command" = apply ]; then
    state=$(docker compose exec -T db sh -c 'exec psql -X -q -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' 2> /dev/null <<'SQL'
SELECT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'sentinel_restricted');
SQL
    ) || state=unknown
    case "$state" in
        f) echo "postgres-roles: nothing was committed: the database has no schema sentinel_restricted" >&2 ;;
        t) echo "postgres-roles: the database is provisioned (schema sentinel_restricted exists), by this run or an earlier one; scripts/postgres-roles.sh status says whether it is as apply left it, in which case apply runs again" >&2 ;;
        *) echo "postgres-roles: whether it committed could not be read: check that the db service runs, then run apply again" >&2 ;;
    esac
fi
exit 1
