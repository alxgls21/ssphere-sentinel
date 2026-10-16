#!/usr/bin/env bash
# Removes the Compose project of a rehearsal (COMPOSE_PROJECT_NAME) with its containers, networks and
# volumes, and fails if anything of it is left. It is for the end of a CI job, whatever came before:
# `docker compose down` needs the project's files in place, so what it cannot remove (or was never
# asked to) is removed by the label Compose puts on all of it. Only that project is touched: the name
# must be one of the rehearsals' (sentinel-...), and every lookup and removal is limited to its label.
# A lookup that fails is an error, never an empty answer: nothing is reported as gone that was not seen.
# A removal that fails does not stop the others: everything is tried, then what is left is reported.
set -euo pipefail

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME names the project to remove}"
case "$COMPOSE_PROJECT_NAME" in
    sentinel-?*) ;;
    *) echo "compose-cleanup: $COMPOSE_PROJECT_NAME is not a project of the rehearsals" >&2; exit 2 ;;
esac
label="label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"

# The identifiers `docker <arguments>` prints, one a line.
list() {
    local output
    output=$(docker "$@") || { echo "compose-cleanup: docker $* failed" >&2; exit 1; }
    printf '%s\n' "$output"
}
docker compose down --volumes --remove-orphans \
    || echo "compose-cleanup: docker compose down failed; removing what is left by its label" >&2

containers=$(list ps --all --quiet --filter "$label")
while IFS= read -r id; do
    if [ -n "$id" ]; then docker rm --force --volumes "$id" || echo "compose-cleanup: could not remove the container $id" >&2; fi
done <<<"$containers"
volumes=$(list volume ls --quiet --filter "$label")
while IFS= read -r id; do
    if [ -n "$id" ]; then docker volume rm --force "$id" || echo "compose-cleanup: could not remove the volume $id" >&2; fi
done <<<"$volumes"
networks=$(list network ls --quiet --filter "$label")
while IFS= read -r id; do
    if [ -n "$id" ]; then docker network rm "$id" || echo "compose-cleanup: could not remove the network $id" >&2; fi
done <<<"$networks"

left=$(list ps --all --quiet --filter "$label"; list volume ls --quiet --filter "$label"; list network ls --quiet --filter "$label")
if [ -n "${left//$'\n'/}" ]; then
    echo "compose-cleanup: something of $COMPOSE_PROJECT_NAME is left" >&2
    exit 1
fi
echo "compose-cleanup: nothing of $COMPOSE_PROJECT_NAME is left"
