"""The only OIDs the agent ever requests.

Fixed numeric OIDs from SNMPv2-MIB and IF-MIB: no MIB files, no compiler and
no way to make the agent read an arbitrary OID. Column names are what the
collector refers to; the fetcher walks the columns it is asked for.
"""

from __future__ import annotations

# SNMPv2-MIB system group (scalars, ".0").
SYS_DESCR = "1.3.6.1.2.1.1.1.0"
SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"
SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
SYS_NAME = "1.3.6.1.2.1.1.5.0"
# IF-MIB: sysUpTime value when the interface table last gained or lost a row.
IF_TABLE_LAST_CHANGE = "1.3.6.1.2.1.31.1.5.0"

_IF_ENTRY = "1.3.6.1.2.1.2.2.1"  # ifTable
_IF_X_ENTRY = "1.3.6.1.2.1.31.1.1.1"  # ifXTable

# Table columns, indexed by ifIndex.
COLUMNS: dict[str, str] = {
    "descr": f"{_IF_ENTRY}.2",
    "type": f"{_IF_ENTRY}.3",
    "speed": f"{_IF_ENTRY}.5",  # ifSpeed: bits/s, saturates at 2**32-1
    "admin": f"{_IF_ENTRY}.7",
    "oper": f"{_IF_ENTRY}.8",
    "in_octets32": f"{_IF_ENTRY}.10",
    "in_discards": f"{_IF_ENTRY}.13",
    "in_errors": f"{_IF_ENTRY}.14",
    "out_octets32": f"{_IF_ENTRY}.16",
    "out_discards": f"{_IF_ENTRY}.19",
    "out_errors": f"{_IF_ENTRY}.20",
    "name": f"{_IF_X_ENTRY}.1",
    "in_octets64": f"{_IF_X_ENTRY}.6",
    "out_octets64": f"{_IF_X_ENTRY}.10",
    "high_speed": f"{_IF_X_ENTRY}.15",  # ifHighSpeed: Mbit/s
    "alias": f"{_IF_X_ENTRY}.18",
    # ifCounterDiscontinuityTime: a sysUpTime value (TimeTicks), 0 if none since the device started.
    "discontinuity": f"{_IF_X_ENTRY}.19",
}

# Walked on every poll. ``oper`` goes first: it defines the interface set.
POLL_COLUMNS = (
    "oper",
    "admin",
    "high_speed",
    "in_octets64",
    "out_octets64",
    "in_errors",
    "out_errors",
    "in_discards",
    "out_discards",
    "discontinuity",
)
# Walked only by a discovery poll.
DISCOVERY_COLUMNS = ("name", "descr", "alias", "type")
# Walked only when a device has no 64-bit counters (or no ifHighSpeed).
FALLBACK_OCTET_COLUMNS = ("in_octets32", "out_octets32")
FALLBACK_SPEED_COLUMN = "speed"
