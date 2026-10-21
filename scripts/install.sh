#!/usr/bin/env bash
# Installs SSphere Sentinel from a release, or updates an installation made by this script.
#
#   curl -fsSL https://github.com/alxgls21/ssphere-sentinel/releases/latest/download/install.sh | sudo bash
#
# or, to read it first: download install.sh and SHA256SUMS from the release, check them with
# `sha256sum --check --ignore-missing SHA256SUMS`, read it, then `sudo bash install.sh`.
#
# A new installation asks for the console's address and how it is reached (Cloudflare Tunnel, a reverse proxy
# on this server, or the local network only), downloads the release's bundle, checks its SHA-256, writes .env
# (no secret: they are created on the first start), starts it and prints the setup code of the first
# administrator. The same command on an installation it made updates it: a backup of the database and of
# .env and ./secrets first, then the new release. It never goes back to an older release (its migrations
# cannot be undone; restore the backup instead), never touches a checkout of the repository, and never
# installs Docker.
#
# Options (each question has one; with --yes, a missing answer is an error instead of a question):
#   --url URL                 the console's address, e.g. https://sentinel.example.com
#   --tunnel                  reached through Cloudflare Tunnel; the token is asked for, hidden, or:
#   --tunnel-token-file FILE  a file that holds the tunnel token
#   --proxy                   reached through a reverse proxy on this server
#   --local                   the local network only, over plain HTTP
#   --port PORT               the port the console is published on (8000)
#   --version VERSION         the release to install, e.g. 0.1.0 (the latest stable one)
#   --dir DIR                 the installation's directory (/opt/ssphere-sentinel)
#   --no-backup               update without a backup
#   --bundle FILE, --checksums FILE
#                             install a bundle and its SHA256SUMS already on this server
#   --yes                     ask nothing
#   -h, --help                this text

main() {
    set -euo pipefail
    umask 022

    local repository=https://github.com/alxgls21/ssphere-sentinel
    local dir=/opt/ssphere-sentinel url="" mode="" token_file="" port="" version="" bundle="" checksums=""
    local backup=true assume_yes=false

    say() { echo "sentinel: $*"; }
    fail() { echo "sentinel: ERROR: $*" >&2; exit 1; }
    usage() { sed -n '2,/^main()/p' "$0" 2> /dev/null | sed -e '/^main()/d' -e 's/^# \{0,1\}//'; }

    while [ $# -gt 0 ]; do
        case "$1" in
            --url) url=${2:?--url needs an address}; shift ;;
            --tunnel) mode=tunnel ;;
            --tunnel-token-file) token_file=${2:?--tunnel-token-file needs a file}; mode=tunnel; shift ;;
            --proxy) mode=proxy ;;
            --local) mode=local ;;
            --port) port=${2:?--port needs a number}; shift ;;
            --version) version=${2:?--version needs a version}; version=${version#v}; shift ;;
            --dir) dir=${2:?--dir needs a directory}; shift ;;
            --no-backup) backup=false ;;
            --bundle) bundle=${2:?--bundle needs a file}; shift ;;
            --checksums) checksums=${2:?--checksums needs a file}; shift ;;
            --yes) assume_yes=true ;;
            -h | --help) usage; exit 0 ;;
            *) fail "unknown option $1 (--help lists them)" ;;
        esac
        shift
    done

    # Questions go to the terminal: when this script is piped to bash, its standard input is the script.
    tty_ok() { ! $assume_yes && { : < /dev/tty; } 2> /dev/null; }
    ask() {  # ask <prompt>: one line from the terminal
        local answer
        tty_ok || return 1
        read -r -p "$1" answer < /dev/tty
        printf '%s' "$answer"
    }

    # --- this server
    [ "$(uname -s)" = Linux ] || fail "SSphere Sentinel runs on a Linux server"
    local tool
    for tool in tar awk sed sha256sum mktemp; do
        command -v "$tool" > /dev/null || fail "$tool is not installed (it is part of every common Linux distribution's base system)"
    done
    if ! command -v docker > /dev/null; then
        fail "Docker is not installed. Install Docker Engine 24 or later with its Compose plugin (https://docs.docker.com/engine/install/), then run this again."
    fi
    local engine compose_version
    engine=$(docker version --format '{{.Server.Version}}' 2> /dev/null) \
        || fail "Docker does not answer: is it running, and may this user use it? (run this with sudo)"
    [ "$(major "$engine")" -ge 24 ] || fail "Docker Engine $engine is too old: 24 or later is needed"
    compose_version=$(docker compose version --short 2> /dev/null) || fail "the Docker Compose plugin (docker compose) is not installed"
    compose_version=${compose_version#v}
    if [ "$(major "$compose_version")" -lt 2 ] || { [ "$(major "$compose_version")" = 2 ] && [ "$(minor "$compose_version")" -lt 24 ]; }; then
        fail "Docker Compose $compose_version is too old: 2.24 or later is needed"
    fi
    local memory
    memory=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2> /dev/null || echo 0)
    say "Docker $engine, Compose $compose_version, ${memory} MB of memory"
    if [ "$memory" -gt 0 ] && [ "$memory" -lt 1000 ]; then
        say "warning: less than 1 GB of memory; SSphere Sentinel needs about 1 GB"
    fi

    # --- what is in the directory already
    local installed=""
    if [ -e "$dir/.git" ]; then
        fail "$dir is a checkout of the repository: update it as docs/server-deployment.md describes (git checkout <tag>, docker compose up -d --build); this script only manages installations it made"
    elif [ -f "$dir/.sentinel-release" ]; then
        installed=$(cat "$dir/.sentinel-release")
    elif [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2> /dev/null)" ]; then
        fail "$dir is not empty and holds no installation made by this script: choose another directory with --dir"
    fi

    # --- the release, checked before anything is written
    work=$(mktemp -d)  # global: the EXIT trap runs after main has returned
    trap 'rm -rf "$work"' EXIT
    if [ -n "$bundle" ]; then
        [ -n "$checksums" ] || fail "--bundle needs --checksums (the release's SHA256SUMS)"
        cp "$checksums" "$work/SHA256SUMS"
        cp "$bundle" "$work/"
    else
        command -v curl > /dev/null || fail "curl is not installed"
        local base
        if [ -n "$version" ]; then base="$repository/releases/download/v$version"; else base="$repository/releases/latest/download"; fi
        curl -fsSL --proto '=https' --tlsv1.2 -o "$work/SHA256SUMS" "$base/SHA256SUMS" \
            || fail "cannot download the release${version:+ $version} ($base)"
    fi
    local archive
    archive=$(sed -n 's/^[0-9a-f]\{64\}  \(sentinel-[0-9][0-9A-Za-z.-]*\.tar\.gz\)$/\1/p' "$work/SHA256SUMS" | head -n 1)
    [ -n "$archive" ] || fail "the release's SHA256SUMS names no bundle"
    local release=${archive#sentinel-}
    release=${release%.tar.gz}
    if [ -n "$version" ] && [ "$release" != "$version" ]; then
        fail "the release's bundle is $release, not $version"
    fi
    if [ -z "$bundle" ]; then
        curl -fsSL --proto '=https' --tlsv1.2 -o "$work/$archive" "$base/$archive" || fail "cannot download $archive"
    elif [ "$(basename "$bundle")" != "$archive" ]; then
        fail "$bundle is not $archive, the bundle SHA256SUMS names"
    fi
    local expected actual
    expected=$(awk -v name="$archive" '$2 == name && $1 ~ /^[0-9a-f]+$/ && length($1) == 64 { print $1; exit }' "$work/SHA256SUMS")
    actual=$(sha256sum "$work/$archive" | awk '{ print $1 }')
    [ -n "$expected" ] && [ "$actual" = "$expected" ] || fail "$archive does not match the release's SHA-256: it was not installed"
    say "SSphere Sentinel $release, checked (SHA-256)"

    if [ -n "$installed" ]; then
        update "$installed"
    else
        install_new
    fi
}

major() { local value=${1%%-*}; value=${value%%.*}; [[ $value =~ ^[0-9]+$ ]] && echo "$value" || echo 0; }
minor() { local value=${1%%-*}; value=${value#*.}; value=${value%%.*}; [[ $value =~ ^[0-9]+$ ]] && echo "$value" || echo 0; }

# version_older A B: A is an older release than B (X.Y.Z, then X.Y.Z-rc.N before X.Y.Z).
version_older() {
    local a=$1 b=$2 base_a=${1%%-*} base_b=${2%%-*}
    if [ "$base_a" != "$base_b" ]; then
        [ "$(printf '%s\n%s\n' "$base_a" "$base_b" | sort -V | head -n 1)" = "$base_a" ]
        return
    fi
    case "$a,$b" in
        *-rc.*,*-rc.*) [ "${a##*-rc.}" -lt "${b##*-rc.}" ] ;;
        *-rc.*,*) return 0 ;;
        *) return 1 ;;
    esac
}

unpack() {  # unpack: the checked bundle into the installation's directory (never .env, .env.tunnel or secrets)
    mkdir -p "$dir"
    tar -xzf "$work/$archive" -C "$dir" --strip-components 1 --no-same-owner
    chmod 755 "$dir/scripts/postgres-preflight.sh"
}

start() {  # start: the database volumes checked, the images pulled, everything healthy
    (cd "$dir" && scripts/postgres-preflight.sh) || fail "the database check refused to start (see above)"
    say "downloading the images"
    (cd "$dir" && docker compose pull --quiet) || fail "the images could not be downloaded"
    say "starting (the first start takes a minute)"
    (cd "$dir" && docker compose up --detach --wait --wait-timeout 600) \
        || fail "SSphere Sentinel did not start: cd $dir && docker compose ps && docker compose logs"
}

install_new() {
    # --- the questions
    if [ -z "$mode" ]; then
        local choice
        choice=$(ask $'How will the console be reached?\n  1) Cloudflare Tunnel\n  2) A reverse proxy on this server (Caddy, nginx, ...)\n  3) The local network only (plain HTTP)\n> ') \
            || fail "say how the console is reached: --tunnel, --proxy or --local"
        case "$choice" in 1) mode=tunnel ;; 2) mode=proxy ;; 3) mode=local ;; *) fail "answer 1, 2 or 3" ;; esac
    fi
    port=${port:-8000}
    [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "--port needs a port number"
    if [ -z "$url" ]; then
        local example=https://sentinel.example.com
        if [ "$mode" = local ]; then
            example="http://$(hostname -I 2> /dev/null | awk '{ print $1 }'):$port"
        fi
        url=$(ask "Address of the console (e.g. $example): ") || fail "give the console's address: --url $example"
    fi
    url=${url%/}
    local host_part=${url#*://}
    [[ $url =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] && [[ $host_part == *.* ]] \
        || fail "$url is not the address of a console: a scheme and a host, e.g. https://sentinel.example.com"
    if [ "$mode" != local ] && [[ $url != https://* ]]; then
        fail "behind Cloudflare Tunnel or a reverse proxy the address is https://"
    fi
    local token=""
    if [ "$mode" = tunnel ]; then
        if [ -n "$token_file" ]; then
            token=$(tr -d '[:space:]' < "$token_file") || fail "cannot read $token_file"
        else
            tty_ok || fail "give the tunnel's token in a file: --tunnel-token-file FILE"
            read -r -s -p "Cloudflare Tunnel token (hidden): " token < /dev/tty
            echo
        fi
        [[ $token =~ ^[A-Za-z0-9+/=_-]{20,}$ ]] || fail "that is not a Cloudflare Tunnel token (Zero Trust > Networks > Tunnels)"
    fi
    if command -v ss > /dev/null && ss -ltn 2> /dev/null | awk '{ print $4 }' | grep -Eq "[:.]$port\$"; then
        fail "port $port is in use on this server: choose another with --port"
    fi

    # --- the installation
    unpack
    local bind=127.0.0.1
    [ "$mode" = local ] && bind=0.0.0.0
    (
        umask 077
        {
            echo "# SSphere Sentinel $release, installed by install.sh. Every setting of .env.example may be added."
            echo "SENTINEL_URL=$url"
            echo "SENTINEL_POSTGRES=18"
            echo "SENTINEL_HTTP_BIND=$bind"
            echo "SENTINEL_HTTP_PORT=$port"
            if [ "$mode" = tunnel ]; then
                echo "# Every docker compose command includes the tunnel (its token is in .env.tunnel)."
                echo "COMPOSE_FILE=compose.yml:compose.tunnel.yml"
            fi
        } > "$dir/.env"
        if [ "$mode" = tunnel ]; then
            printf 'TUNNEL_TOKEN=%s\n' "$token" > "$dir/.env.tunnel"
        fi
    )
    unset token
    # From here on the directory is this script's: an interrupted first start is finished by running it again.
    echo "$release" > "$dir/.sentinel-release"
    start

    # --- what is next
    local code
    code=$(cd "$dir" && docker compose logs --no-color web 2> /dev/null \
        | sed -n 's/.*setup:     \([2-9A-HJ-NP-Z]\{4\}-[2-9A-HJ-NP-Z]\{4\}-[2-9A-HJ-NP-Z]\{4\}\)$/\1/p' | tail -n 1)
    say "SSphere Sentinel $release is running in $dir"
    case "$mode" in
        tunnel) say "in Cloudflare Zero Trust, give the tunnel the public hostname ${url#https://} with the service http://proxy:8080" ;;
        proxy) say "point the HTTPS reverse proxy for ${url#https://} at http://127.0.0.1:$port, e.g. with Caddy:"
               printf '\n    %s {\n        reverse_proxy 127.0.0.1:%s\n    }\n\n' "${url#https://}" "$port" ;;
        local) say "warning: over plain HTTP, passwords cross the network unencrypted: use it on a trusted network only" ;;
    esac
    if [ -n "$code" ]; then
        say "open $url and create the administrator with the setup code:"
        echo
        echo "    $code"
        echo
    else
        say "open $url"
    fi
}

update() {
    local from=$1
    if [ "$from" = "$release" ]; then
        say "$dir already runs $release: starting it"
        start
        return
    fi
    if version_older "$release" "$from"; then
        fail "$dir runs $from, newer than $release: a release never goes back (restore the backup taken before the update instead)"
    fi
    say "updating $dir from $from to $release"
    if $backup; then
        local stamp folder
        stamp=$(date +%Y%m%d-%H%M%S)
        folder="$dir/backups"
        mkdir -p "$folder"
        chmod 700 "$folder"
        (cd "$dir" && docker compose up --detach --wait --wait-timeout 300 db > /dev/null) \
            || fail "the database does not start, so no backup could be taken: nothing was updated"
        (cd "$dir" && docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom') \
            > "$folder/sentinel-$from-$stamp.dump" || fail "the backup of the database failed: nothing was updated"
        local settings=()
        for name in .env .env.tunnel secrets; do
            [ -e "$dir/$name" ] && settings+=("$name")
        done
        tar -czpf "$folder/settings-$from-$stamp.tar.gz" -C "$dir" "${settings[@]}" \
            || fail "the backup of the settings failed: nothing was updated"
        say "backup: $folder/sentinel-$from-$stamp.dump and settings-$from-$stamp.tar.gz"
    fi
    unpack
    start
    echo "$release" > "$dir/.sentinel-release"
    say "SSphere Sentinel $release is running in $dir (new settings, if any: compare .env.example with .env)"
}

main "$@"
