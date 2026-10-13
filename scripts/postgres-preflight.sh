#!/usr/bin/env bash
# Read-only preflight for the PostgreSQL volumes of the Compose stack.
#
# Run it from the project directory, with the same environment you run
# `docker compose` with, before starting or restarting the stack:
#
#   scripts/postgres-preflight.sh
#
# It compares the PostgreSQL version SENTINEL_POSTGRES selects with the database
# volumes Docker already has for the project, and refuses a start that would
# initialise an empty database next to existing data or bring back an older
# database. It only lists and inspects: it never creates, changes or removes a
# volume, and it never reads or writes database files.
#
# Options (each authorises exactly one situation):
#   --migrate       PostgreSQL 18 is selected on purpose, while the PostgreSQL 16
#                   volume exists, to start the empty database a dump is restored
#                   into (docs/server-deployment.md, step 2).
#   --confirm 16|18 Both volumes exist, so the script cannot tell which database
#                   is the live one: name the version you mean to start. It must
#                   equal SENTINEL_POSTGRES.
#
# Exit status: 0 safe to start, 1 refused (unsafe switch), 2 ambiguous (both
# volumes exist and --confirm is missing), 3 the state could not be determined.
#
# A volume that exists is taken to hold a database. Starting the stack with
# `docker compose up` directly bypasses this check.
set -euo pipefail

LEGACY_KEY=postgres_data     # PostgreSQL 16
CURRENT_KEY=postgres18_data  # PostgreSQL 18

migrate=false
confirm=""

usage() {
    sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
}

say() { echo "preflight: $*"; }
indent() { printf '           %s\n' "$@"; }
error() { say "ERROR: $1"; exit 3; }

while [ $# -gt 0 ]; do
    case "$1" in
        --migrate) migrate=true ;;
        --confirm)
            [ $# -ge 2 ] || error "--confirm needs 16 or 18"
            confirm=$2
            shift
            ;;
        -h | --help) usage; exit 0 ;;
        *) usage >&2; exit 3 ;;
    esac
    shift
done
case "$confirm" in "" | 16 | 18) ;; *) error "--confirm needs 16 or 18" ;; esac

# What Compose resolves: the selected version's volume and the project name.
config=$(docker compose config) || error "docker compose cannot resolve the configuration"
selected_key=$(docker compose config --volumes) || error "docker compose cannot list the volumes"
project=$(awk '/^name:/ { print $2; exit }' <<<"$config")
[ -n "$project" ] || error "cannot determine the Compose project name"
case "$selected_key" in
    "$LEGACY_KEY") selected=16 ;;
    "$CURRENT_KEY") selected=18 ;;
    *) error "unsupported database volume '$selected_key'" ;;
esac

legacy="${project}_${LEGACY_KEY}"
current="${project}_${CURRENT_KEY}"
volumes=$(docker volume ls --quiet) || error "cannot list Docker volumes"

has_volume() { grep -Fxq -- "$1" <<<"$volumes"; }
describe() {  # describe <label> <volume>
    if has_volume "$2"; then
        say "$1 volume $2: present (created $(docker volume inspect --format '{{.CreatedAt}}' "$2"))"
    else
        say "$1 volume $2: absent"
    fi
}

say "project '$project' selects PostgreSQL $selected (SENTINEL_POSTGRES)"
describe "PostgreSQL 16" "$legacy"
describe "PostgreSQL 18" "$current"

have16=false; have18=false
has_volume "$legacy" && have16=true
has_volume "$current" && have18=true

safe() { say "OK: $1"; exit 0; }
refuse() {
    say "REFUSED: $1"
    shift
    indent "$@"
    exit 1
}

if ! $have16 && ! $have18; then
    note="PostgreSQL $selected will create its database."
    if [ "$selected" = 18 ]; then
        note="$note It needs SENTINEL_POSTGRES_INITIALIZE=true for that first start."
    else
        note="$note PostgreSQL 18 is the default for new installations (SENTINEL_POSTGRES=18)."
    fi
    safe "new installation, no database volume yet. $note"
fi

if $have16 && ! $have18; then
    if [ "$selected" = 16 ]; then
        safe "existing PostgreSQL 16 installation, PostgreSQL 16 selected."
    fi
    if $migrate; then
        safe "migration authorised: set SENTINEL_POSTGRES_INITIALIZE=true, start only the database service (docker compose up -d --wait db) and restore the dump into it."
    fi
    refuse "PostgreSQL 18 is selected but only the PostgreSQL 16 volume exists." \
        "Starting it would create an empty PostgreSQL 18 database next to your data." \
        "To move to PostgreSQL 18, follow 'Moving an existing installation to PostgreSQL 18'" \
        "in docs/server-deployment.md; its step 2 uses --migrate. Otherwise remove SENTINEL_POSTGRES from .env."
fi

if ! $have16 && $have18; then
    if [ "$selected" = 18 ]; then
        safe "existing PostgreSQL 18 installation, PostgreSQL 18 selected."
    fi
    refuse "PostgreSQL 16 is selected but only the PostgreSQL 18 volume exists." \
        "Starting it would create an empty PostgreSQL 16 database; there is no PostgreSQL 16 data to return to." \
        "Set SENTINEL_POSTGRES=18 in .env."
fi

# Both volumes exist (after a migration, a rollback, or a refused start that left
# an empty volume behind): existence alone does not say which one is live.
if [ -z "$confirm" ]; then
    say "AMBIGUOUS: both database volumes exist, PostgreSQL $selected is selected."
    indent "One of them is a copy kept for rollback (or an empty volume left by a refused start)." \
        "If PostgreSQL $selected is the database to start, confirm it: scripts/postgres-preflight.sh --confirm $selected" \
        "To retire the copy once you no longer need it, see 'Afterwards' in docs/server-deployment.md."
    exit 2
fi
if [ "$confirm" != "$selected" ]; then
    refuse "PostgreSQL $confirm was confirmed but SENTINEL_POSTGRES selects PostgreSQL $selected." \
        "Fix SENTINEL_POSTGRES in .env or confirm the version it selects."
fi
safe "both volumes exist; PostgreSQL $selected confirmed as the database to start."
