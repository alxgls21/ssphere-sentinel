#!/usr/bin/env bash
# Installs Docker Compose <version> (for example 2.24.6) as the docker CLI plugin
# of the current user, checked against the checksum its release publishes, and
# lets the daemon accept the older API version of releases before Compose 2.24.
set -euo pipefail

version=${1:?usage: install-compose.sh <version>}
url=https://github.com/docker/compose/releases/download/v$version/docker-compose-linux-x86_64
plugins=$HOME/.docker/cli-plugins
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT

curl --fail --silent --show-error --location --retry 3 --output "$download/docker-compose-linux-x86_64" "$url"
curl --fail --silent --show-error --location --retry 3 --output "$download/checksum" "$url.sha256"
(cd "$download" && sed 's/ \*/  /' checksum | sha256sum --check --strict)
mkdir -p "$plugins"
install -m 0755 "$download/docker-compose-linux-x86_64" "$plugins/docker-compose"

installed=$(docker compose version --short)
[ "${installed#v}" = "$version" ] || { echo "docker compose reports $installed, not $version" >&2; exit 1; }

# Compose before 2.24 speaks Docker API 1.43 at most; newer engines refuse it
# unless their minimum API version is lowered.
minimum=$(docker version --format '{{.Server.MinAPIVersion}}')
if [ "$(printf '%s\n1.43\n' "$minimum" | sort -V | head -n 1)" != "$minimum" ]; then
    sudo mkdir -p /etc/systemd/system/docker.service.d
    printf '[Service]\nEnvironment=DOCKER_MIN_API_VERSION=1.24\n' \
        | sudo tee /etc/systemd/system/docker.service.d/minimum-api.conf > /dev/null
    sudo systemctl daemon-reload
    sudo systemctl restart docker
fi
docker compose version
docker version --format 'Docker Engine {{.Server.Version}}, API {{.Server.MinAPIVersion}} to {{.Server.APIVersion}}'
