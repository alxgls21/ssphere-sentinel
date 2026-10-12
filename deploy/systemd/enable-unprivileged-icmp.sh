#!/bin/sh
# Allow unprivileged ICMP echo ("ping") sockets for the agent's group only.
#
#   sudo sh enable-unprivileged-icmp.sh [group]     # default group: sentinel-agent
#
# The hardened unit gives the agent no capabilities (NoNewPrivileges=yes, an
# empty CapabilityBoundingSet=), so ping cannot use the CAP_NET_RAW file
# capability it has on Debian and Ubuntu. It then needs the kernel's
# unprivileged ICMP sockets, which only groups within net.ipv4.ping_group_range
# may open. Debian and Ubuntu leave that range at the kernel default "1 0"
# (no group). This script adds a sysctl drop-in that allows exactly the
# agent's group, applies it now and checks that the kernel accepted it;
# systemd-sysctl re-applies it at boot.
#
# It never narrows or replaces an existing range: if the group is already
# allowed (some distributions allow all groups) it changes nothing, and if a
# different range is active or configured in another sysctl file it stops and
# asks you to extend that range yourself.
set -eu

group=${1:-sentinel-agent}
# Overridable for tests only (sudo resets the environment).
range_file=${PING_GROUP_RANGE_FILE:-/proc/sys/net/ipv4/ping_group_range}
conf=${SENTINEL_ICMP_SYSCTL_CONF:-/etc/sysctl.d/60-ssphere-sentinel-agent-icmp.conf}
sysctl_dirs=${SENTINEL_SYSCTL_CONF_DIRS:-/etc/sysctl.d /run/sysctl.d /usr/local/lib/sysctl.d /usr/lib/sysctl.d /lib/sysctl.d}

# A decimal ID of at most 10 digits (so "[ -le ]" can always compare it).
is_id() {
    case $1 in
        '' | *[!0-9]* | ???????????*) return 1 ;;
    esac
}

# Sets low and high from the range file, or exits with an error.
#
# The file is read with one read(2) through cat: numeric files under /proc/sys
# return end-of-file for any read at a non-zero offset, and dash's "read"
# builtin reads one byte at a time, so reading the file directly would only
# ever see the first digit.
load_range() {
    if ! range=$(cat "$range_file"); then
        echo "error: cannot read $range_file" >&2
        exit 1
    fi
    low= high= extra=
    case $range in
        *'
'*) ;;  # more than one line: rejected below
        *) read -r low high extra <<EOF
$range
EOF
        ;;
    esac
    if ! is_id "$low" || ! is_id "$high" || [ -n "$extra" ]; then
        echo "error: unexpected net.ipv4.ping_group_range value in $range_file: '$range'" >&2
        exit 1
    fi
}

allowed() {
    [ "$low" -le "$gid" ] && [ "$gid" -le "$high" ]
}

gid=$(getent group "$group" | cut -d: -f3)
if [ -z "$gid" ]; then
    echo "error: group '$group' does not exist (create the service account first)" >&2
    exit 1
fi
if ! is_id "$gid"; then
    echo "error: unexpected gid for group '$group': '$gid'" >&2
    exit 1
fi

load_range
if allowed; then
    echo "unprivileged ICMP already allowed for $group (gid $gid): ping_group_range = $low $high"
    exit 0
fi
if [ "$low" -le "$high" ]; then
    echo "error: net.ipv4.ping_group_range is '$low $high', which does not include $group (gid $gid)." >&2
    echo "It is already in use for other groups; extend the range to cover gid $gid yourself." >&2
    exit 1
fi

# The range is not active, but another sysctl file may still configure it
# (systemd-sysctl applies all of them at boot, in file name order): ours could
# then override that range, so leave the decision to the administrator.
for dir in $sysctl_dirs; do
    for file in "$dir"/*.conf; do
        [ -f "$file" ] && [ "$file" != "$conf" ] || continue
        if grep -Eq '^[[:space:]]*-?net[./]ipv4[./]ping_group_range[[:space:]]*=' "$file"; then
            echo "error: $file already configures net.ipv4.ping_group_range." >&2
            echo "Extend that setting to cover $group (gid $gid) instead of adding another one." >&2
            exit 1
        fi
    done
done

printf '%s\n' \
    "# SSphere Sentinel agent: unprivileged ICMP echo sockets for group $group only." \
    "# Written by enable-unprivileged-icmp.sh; see docs/agent-deployment.md." \
    "net.ipv4.ping_group_range = $gid $gid" > "$conf"

# Apply it and check what the kernel now reports. Ubuntu's sysctl exits 0 even
# when the write is refused (e.g. in a container), so its status is not enough.
# On failure the drop-in is removed: nothing is left that was not applied.
if ! sysctl -q -p "$conf"; then
    rm -f "$conf"
    echo "error: sysctl could not apply net.ipv4.ping_group_range; nothing was changed" >&2
    exit 1
fi
load_range
if ! allowed; then
    rm -f "$conf"
    echo "error: net.ipv4.ping_group_range is still '$low $high' after applying it; the kernel did not accept the change (container or restricted /proc/sys?)" >&2
    exit 1
fi
echo "unprivileged ICMP allowed for $group (gid $gid) in $conf"
