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
# agent's group and applies it now; systemd-sysctl re-applies it at boot.
#
# It never narrows or replaces an existing range: if the group is already
# allowed (some distributions allow all groups) it changes nothing, and if a
# different range is configured it stops and asks you to extend it yourself.
set -eu

group=${1:-sentinel-agent}
# Overridable for tests only (sudo resets the environment).
range_file=${PING_GROUP_RANGE_FILE:-/proc/sys/net/ipv4/ping_group_range}
conf=${SENTINEL_ICMP_SYSCTL_CONF:-/etc/sysctl.d/60-ssphere-sentinel-agent-icmp.conf}

gid=$(getent group "$group" | cut -d: -f3)
if [ -z "$gid" ]; then
    echo "error: group '$group' does not exist (create the service account first)" >&2
    exit 1
fi

read -r low high < "$range_file"
if [ "$low" -le "$gid" ] && [ "$gid" -le "$high" ]; then
    echo "unprivileged ICMP already allowed for $group (gid $gid): ping_group_range = $low $high"
    exit 0
fi
if [ "$low" -le "$high" ]; then
    echo "error: net.ipv4.ping_group_range is '$low $high', which does not include $group (gid $gid)." >&2
    echo "It is already in use for other groups; extend the range to cover gid $gid yourself." >&2
    exit 1
fi

printf '%s\n' \
    "# SSphere Sentinel agent: unprivileged ICMP echo sockets for group $group only." \
    "# Written by enable-unprivileged-icmp.sh; see docs/agent-deployment.md." \
    "net.ipv4.ping_group_range = $gid $gid" > "$conf"
sysctl -q -p "$conf"
echo "unprivileged ICMP allowed for $group (gid $gid) in $conf"
