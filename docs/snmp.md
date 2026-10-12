# SNMP monitoring

Sentinel monitors network devices over SNMP in two halves. The **agent** polls
the devices from inside their network (nothing is exposed inbound, and the
server never polls anything) and reports through its heartbeat. The **server**
stores reachability, interfaces and counters, with history.

This document covers both: the [quick start](#quick-start), the
[agent collector](#the-agent-collector), then what the server
[stores](#what-is-stored-server-side), its [payload contract](#the-snmp-heartbeat-section-version-1),
[acknowledgements](#acknowledgement), [retention](#retention-and-database-growth)
and [limitations](#limitations).

SNMP is optional at both ends. An agent installed without the `[snmp]` extra, or
without an SNMP devices file, behaves exactly as it did before, and a heartbeat
without an `snmp` section is handled exactly as before.

## Quick start

1. **Server.** In the admin, under **Inventory → Devices**, add the device
   (management address, and the agent that can reach it) and fill the SNMP
   section: SNMP version, port, poll interval and a **credential profile
   name** of your choice (for example `core-switches`). Note the device's UUID.
2. **Agent host.** Install the agent with the SNMP extra:

   ```bash
   sudo /opt/ssphere-sentinel-agent/venv/bin/pip install \
       "ssphere-sentinel-agent[snmp] @ git+https://github.com/alxgls21/ssphere-sentinel@<tag>#subdirectory=agent"
   ```

3. **Credentials**, in a file only the agent can read
   (`/etc/ssphere-sentinel-agent/snmp_credentials.json`, mode `0640`,
   `root:sentinel-agent`). The profile name is the one from step 1:

   ```json
   {
     "profiles": {
       "core-switches": {
         "version": "3",
         "username": "sentinel",
         "auth_protocol": "SHA-256",
         "auth_password": "an-authentication-passphrase",
         "priv_protocol": "AES-128",
         "priv_password": "a-privacy-passphrase"
       }
     }
   }
   ```

4. **Devices**, in `/etc/ssphere-sentinel-agent/snmp_devices.json`
   (`0640`, `root:sentinel-agent`). The `id` is the device UUID from step 1:

   ```json
   {
     "devices": [
       {
         "id": "0b8f0a5e-2f0e-4c1c-8f65-1e0d4f0d7d2a",
         "name": "core-sw-1",
         "address": "192.0.2.10",
         "credential_profile": "core-switches"
       }
     ]
   }
   ```

5. Enable it in `agent.env` and restart the agent:

   ```ini
   SENTINEL_SNMP_DEVICES_FILE=/etc/ssphere-sentinel-agent/snmp_devices.json
   SENTINEL_SNMP_CREDENTIALS_FILE=/etc/ssphere-sentinel-agent/snmp_credentials.json
   ```

6. Check. The journal shows `SNMP monitoring: 1 enabled device(s), 4 concurrent
   poll(s) at most`, and after the first poll (within seconds) the device appears
   under **SNMP → Device SNMP states** in the admin.

The server must be upgraded first (see [Upgrade notes](#upgrade-notes)).

## The agent collector

The collector is part of the agent (`agent/snmp_*.py`). It is optional: the
agent's only required dependency is still `psutil`.

- It polls the devices **listed in its local devices file**, each on its own
  interval, with a bounded worker pool that is separate from the ICMP/TCP probes.
- It reads only a fixed set of IF-MIB and SNMPv2-MIB objects (see
  [What a poll reads](#what-a-poll-reads)).
- It computes counter deltas itself and sends them with the raw counters.
- It writes every poll to a persistent local queue first and sends it with the
  following heartbeats, removing it only when the server acknowledges it.
- It keeps the credentials to itself: they are read from a local file, handed to
  the SNMP library and never queued, logged or sent.

### Installing

```bash
pip install "ssphere-sentinel-agent[snmp] @ git+https://github.com/alxgls21/ssphere-sentinel@<tag>#subdirectory=agent"
# from a checkout:
pip install "./agent[snmp]"
```

The extra installs `pysnmp` (the 7.1 series, which supports SNMPv2c and
SNMPv3) and `cryptography` (what pysnmp uses for AES privacy). Without them,
and with a devices file configured, the agent logs `SNMP monitoring disabled:
pysnmp is not installed; ...` once and carries on with everything else.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTINEL_SNMP_DEVICES_FILE` | unset | JSON file with the devices to poll. SNMP is off while unset |
| `SENTINEL_SNMP_CREDENTIALS_FILE` | unset | JSON file with the credential profiles. Required with the devices file |
| `SENTINEL_SNMP_MAX_CONCURRENT_POLLS` | `4` (1–16) | Polls that may run at the same time |
| `SENTINEL_SNMP_QUEUE_MAX_POLLS` | `10000` (100–1,000,000) | Queued polls kept before the oldest are dropped |
| `SENTINEL_SNMP_QUEUE_MAX_BYTES` | `536870912` (512 MiB; 1 MiB–2 GiB) | The same limit, by size of the queued polls. See [Queue and delivery](#queue-and-delivery) for sizing |
| `SENTINEL_QUEUE_PATH`, `SENTINEL_QUEUE_MAX_AGE_SECONDS` | as for network monitoring | SNMP polls share the queue file and the age limit |

An invalid value is logged and replaced by its default. A configuration error
in either file turns SNMP off with one clear message and never stops
heartbeats, telemetry, Docker or network monitoring.

### The devices file

```json
{
  "devices": [
    {
      "id": "0b8f0a5e-2f0e-4c1c-8f65-1e0d4f0d7d2a",
      "name": "core-sw-1",
      "address": "192.0.2.10",
      "port": 161,
      "credential_profile": "core-switches",
      "enabled": true,
      "poll_interval_seconds": 300,
      "timeout_seconds": 5,
      "retries": 1,
      "discovery_interval_seconds": 21600,
      "interfaces": {
        "include": ["Gi0/*", "Po*"],
        "exclude": ["Gi0/48"],
        "max_interfaces": 256
      }
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `id` | Required. The device's UUID in Sentinel; the device must be assigned to this agent |
| `name` | Required. A label for the agent's own logs |
| `address` | Required. IPv4 or IPv6 address, or a host name (resolved to IPv4). An address containing `:` is polled over IPv6 |
| `credential_profile` | Required. A profile name from the credentials file |
| `port` | 1–65535, default 161 |
| `enabled` | Default `true`. A disabled device is not polled (and its profile need not exist) |
| `poll_interval_seconds` | 30–86,400, default 300 |
| `timeout_seconds` | 1–60, default 5. Wait for each request |
| `retries` | 0–5, default 1. Retransmissions after a timeout |
| `discovery_interval_seconds` | 300–604,800, default 21,600 (6 h). See [What a poll reads](#what-a-poll-reads) |
| `interfaces` | Optional. [Interface selection](#interface-selection) |

`timeout_seconds × (retries + 1)` must be shorter than `poll_interval_seconds`
(the same rule the server applies to a device's SNMP settings). The file holds at
most 200 devices. Unknown fields are errors, so a typo is never silently
ignored.

The devices file is authoritative for the agent: the server's per-device version,
port, interval, timeout and retries are what an operator *intends*, and today the
agent does not fetch them. Keep both in step. The server settings the agent does
rely on are the device's existence, its assignment to this agent, its `enabled`
flag and the presence of an SNMP configuration.

### Credential profiles

```json
{
  "profiles": {
    "core-switches": {
      "version": "3",
      "username": "sentinel",
      "auth_protocol": "SHA-256",
      "auth_password": "…",
      "priv_protocol": "AES-256",
      "priv_password": "…",
      "context_name": ""
    },
    "branch-routers": {
      "version": "2c",
      "community": "…"
    }
  }
}
```

| Setting | SNMPv3 | SNMPv2c |
| --- | --- | --- |
| `version` | `"3"` | `"2c"` |
| Authentication | `auth_protocol`: `SHA-512`, `SHA-384`, `SHA-256`, `SHA-224` or `SHA` (SHA-1); `auth_password` (at least 8 characters). **Required** | `community` |
| Privacy | `priv_protocol`: `AES-128`, `AES-192` or `AES-256`; `priv_password` (at least 8 characters). Optional but recommended | none |
| Other | `username` (required), `context_name` (optional, default empty) | none |

Protocol names are not case-sensitive and `-`/`_` are ignored (`sha256`,
`SHA_256` and `SHA-256` are the same). Not supported, by design: **SNMPv1, MD5
authentication, DES and 3DES privacy**, and SNMPv3 without authentication. AES-192
and AES-256 use the key-extension variant that most vendors implement (Cisco and
others); the Blumenthal variant is not supported (use AES-128 on such a device).

Secure by default, and loud about the exceptions. At start-up the agent logs one
line per weak profile: SNMPv2c (the community is sent in clear text), the default
communities `public` and `private`, SNMPv3 without privacy (authentication
only), and SHA-1. It never logs a secret.

**Where the credentials live.** Only in the credentials file, which Sentinel never
sees:

- The file must be a regular file (a symlink is refused), owned by the agent's user
  or by root, not accessible to other users and not writable by group or others:
  mode `0600`, or `0640` for `root:sentinel-agent` as in the quick start. Anything
  else is a configuration error that names the problem and turns SNMP off.
- Nothing from the file is queued: the queue stores only the fields of the payload
  documented below, through a whitelist that drops anything else, so even a
  credential that leaked into a poll would never reach the queue file or the network.
- Configuration errors and failures never print a secret, only the key and the rule
  (`auth_password must be at least 8 characters`). Library error messages are
  scrubbed of every secret before they are logged.
- Unknown keys are refused: a typo such as `priv_pasword` cannot silently downgrade
  a device to weaker security.

### Interface selection

A device may have hundreds of interfaces, most of them uninteresting, and every
monitored interface costs a row per poll
([database growth](#retention-and-database-growth)). The collector therefore
separates **listed** interfaces (the inventory: name, type, speed, status) from
**monitored** interfaces (counters and history).

- By default everything is monitored except loopback, VLAN, tunnel and other
  virtual interfaces (`ifType` 24, 53, 131, 135, 136 and 150). Link aggregation
  groups (161) and physical ports are monitored.
- With `include` patterns, only interfaces that match are monitored, including
  virtual ones the patterns name.
- `exclude` patterns always win.
- Patterns are shell-style (`*`, `?`, `[abc]`), case-sensitive, and are matched
  against both the interface name (`ifName`) and its description (`ifDescr`).
- `max_interfaces` (1–512, default 256) caps the monitored interfaces; the lowest
  `ifIndex` values are kept and the agent logs once that it applied the cap.

All interfaces, monitored or not, are sent by a discovery poll so the server's
inventory is complete (up to its limit of 512 interfaces per poll; a device with
more cannot have a complete inventory, and the agent says so).

### What a poll reads

Only these objects, as fixed numeric OIDs. There are no MIB files and no way to make
the agent read anything else.

| Group | Objects |
| --- | --- |
| Every poll | `sysUpTime.0` and `ifTableLastChange.0` (one GET, which also times the response); then walks of `ifOperStatus`, `ifAdminStatus`, `ifHighSpeed`, `ifHCInOctets`, `ifHCOutOctets`, `ifInErrors`, `ifOutErrors`, `ifInDiscards`, `ifOutDiscards` |
| Discovery polls, too | `sysName.0`, `sysDescr.0`, `sysObjectID.0` and walks of `ifName`, `ifDescr`, `ifAlias`, `ifType` |
| Only when needed | `ifInOctets` and `ifOutOctets` (32-bit) if any interface has no 64-bit octet counters; `ifSpeed` if any interface has no positive `ifHighSpeed` |

Walks use GETBULK (25 repetitions per request) and never run longer than the poll
deadline. Speed is `ifHighSpeed` × 1,000,000, else `ifSpeed`; a saturated or zero
`ifSpeed` without `ifHighSpeed` means unknown. 64-bit counters (`octets_bits: 64`)
are preferred, the 32-bit ones are the fallback (`octets_bits: 32`), and errors
and discards are always 32-bit.

A **discovery poll** also reads the names, types and aliases and lists *every*
interface, so the server can mark vanished ones absent (`interfaces_complete`).
It is the first poll after the agent starts and then repeats every
`discovery_interval_seconds`, and the next poll becomes a discovery poll as soon
as the agent sees that the device restarted, that `ifTableLastChange` moved or
that the set of interfaces changed. A **regular poll** lists the monitored
interfaces only, with the descriptive fields remembered from the last discovery
(the server overwrites an interface's name with whatever a poll says, so a poll
must never omit it).

Whatever the server would reject is left out, so a buggy device cannot cost a
poll: interfaces with an `ifIndex` outside 1–2,147,483,647 and with a status outside
the IF-MIB ranges are skipped, a `sysUpTime` outside 0–4,294,967,295 is not
reported (and is never taken for a restart), a `sysObjectID` that is not a dotted
OID is omitted, and raw counter values beyond what the server stores are sent as
null.

A device that answers `sysUpTime` but has no interface table is *reachable*: the
poll records reachability and uptime, the agent warns once, and the server's
inventory is not touched (an empty answer never marks interfaces absent).

### Counters and deltas

For each monitored interface the agent keeps the previous reading in memory and
sends the raw counters and the increase since the previous poll, qualified by a
`delta_state` (the table in [Counters: raw values and deltas](#counters-raw-values-and-deltas)).
The agent decides the state as follows:

| State | When |
| --- | --- |
| `first` | No previous reading: the first poll after the agent starts, or nothing countable on both polls. The agent keeps readings in memory, so a restart costs one interval of deltas |
| `reboot` | `sysUpTime` went backwards (a 32-bit tick wrap, every ~497 days, is recognised and is not a reboot) |
| `gap` | The previous reading is older than 3.5 poll intervals (for example after an outage), or the clock did not advance. A `gap` or `reboot` after more than a week carries no `interval_seconds` (the server accepts at most a week) |
| `reset` | A counter went backwards and that is not a plausible wrap, or the octet width changed between polls |
| `speed_changed` | Deltas valid, but the interface speed differs from the previous reading |
| `ok` | Deltas valid |

How a decrease is read:

- A **64-bit** counter never "wraps": any decrease is a `reset`.
- A **32-bit octet** counter that decreases has wrapped if the traffic that implies
  fits the link: the increase over the interval, as a rate, is at most 1.5 times the
  interface speed. Busy links with 32-bit counters wrap all the time, so this must
  not be a `reset`; on a slow link a decrease that would need more than the link can
  carry is.
- Any other 32-bit counter (errors, discards, or octets of unknown speed) is taken
  as wrapped only if the implied increase is below half the range: such counters
  practically never wrap, so a large "wrap" is almost surely a counter that was
  cleared.

One implausible counter makes the whole interface `reset`: a partial delta would
mislead more than none. Intervals are measured between the starts of two polls with
a monotonic clock.

Two limits cannot be removed. A **32-bit counter that wraps more than once between
two polls** looks like one wrap or none, so its delta is too low; at 300 s that
happens above about 229 Mbit/s of average traffic (a single wrap, from about
114 Mbit/s, is handled). And a 32-bit octet counter that is **cleared by hand** on a
fast link looks like a plausible wrap (a device restart is caught by its uptime
instead). Devices that offer `ifHC*` counters, almost all of them, have neither
limit; for the rest, poll more often.

### Unreachable devices

A device that cannot be read produces a poll with `reachable: false` and an
error category, never an exception and never a missing poll, so the server has
the history of outages too. The category is chosen from what the SNMP library
reports:

| `error` | Typical cause |
| --- | --- |
| `timeout` | No answer within `timeout_seconds × (retries + 1)`, or the poll's deadline passed. SNMPv2c devices also stay silent for a wrong community |
| `auth_failure` | SNMPv3: unknown user, wrong authentication or privacy key, wrong protocol, unsupported security level; or an authorization error from the device |
| `dns_failure` | The host name does not resolve, or not within the poll's deadline |
| `unreachable` | The network refused to send (no route, interface down) |
| `protocol_error` | A malformed answer, an error status, a non-increasing OID, a table with more than 4,096 rows |
| `unsupported` | The device does not provide `sysUpTime` |
| `unknown` | Anything else |

The first failure and each change of category is logged once as a warning
(`SNMP device core-sw-1 (…) is unreachable: timeout`), and recovery as one info
line; a device that stays down does not flood the log.

### Concurrency, timeouts and retries

- At most `SENTINEL_SNMP_MAX_CONCURRENT_POLLS` polls run at once, in a worker pool
  created once. It is separate from the network probe pool, so slow SNMP devices
  never delay ICMP/TCP probes and the other way round.
- A device never has two polls in flight. A poll that overruns its interval delays
  the next one, and missed slots are skipped, not run in a burst.
- First polls are spread over the first seconds after start (a quarter of a second
  per device, at most 30 s).
- Each request waits `timeout_seconds`, retried `retries` times. The whole poll
  has a hard deadline: the shorter of its poll interval and 120 s, name resolution
  included (a host name is resolved in a helper thread that the poll stops waiting
  for at the deadline, so a hanging resolver cannot hold a worker). A poll cannot
  hang the agent.
- Each poll uses a private SNMP engine and event loop that are closed when the poll
  ends: nothing is shared between devices and nothing accumulates.
- On shutdown the running polls are cancelled and finish within a fraction of a
  second; the agent exits cleanly.

### Queue and delivery

Polls are written to the table `pending_snmp` of the agent's SQLite queue file
(the same file and connection as network measurements, `SENTINEL_QUEUE_PATH`),
whitelisted field by field. The table is additive: the schema version did not
change, an older agent ignores it, and this agent adds it to an existing file.

- A poll is sent in a heartbeat's `snmp` section: at most 50 polls, 2,000
  interfaces and about 1 MB per report, within what the server accepts. One poll
  is at most 768 KiB: interface names and descriptions are shortened to 128
  characters and aliases to 64 (the IF-MIB limit), and a poll of 512 interfaces
  with the longest text still fits.
- It is removed from the queue only when the server acknowledges it as `created`
  or `duplicate`, or rejects it with `retryable: false` (logged and dropped).
  Retryable rejections (the device is not created, assigned or configured yet,
  the clock) and polls missing from the response stay queued and are retried with
  exponential backoff (30 s up to 10 min); a poll that the server fails to
  acknowledge 10 times is dropped.
- If the whole section fails (a server without SNMP support, an envelope
  rejection, HTTP errors, a connection failure) every poll stays queued and SNMP
  batches pause with the same backoff. Heartbeats, telemetry, Docker and network
  delivery are not affected.
- The queue holds at most `SENTINEL_SNMP_QUEUE_MAX_POLLS` polls and
  `SENTINEL_SNMP_QUEUE_MAX_BYTES`, and nothing older than
  `SENTINEL_QUEUE_MAX_AGE_SECONDS` (default 7 days, below the server's
  `SENTINEL_SNMP_MAX_AGE_DAYS`). Overflow drops the oldest polls and is logged at
  most once a minute, with the number dropped. A restarted agent resends what is
  queued; the server treats repeats as duplicates.
- **Sizing.** A queued poll takes about 520 bytes per interface (measured: 130
  interfaces, 67 KB), so a monitored interface polled every 300 s adds about 150 KB a
  day. The default 512 MiB therefore buffers roughly 3.5 days for 1,000 monitored
  interfaces and 14 days for 250; a shorter poll interval shortens that in
  proportion. To ride out a longer server outage, raise `SENTINEL_SNMP_QUEUE_MAX_BYTES`
  (up to 2 GiB) and `SENTINEL_QUEUE_MAX_AGE_SECONDS` (the server accepts polls up to
  `SENTINEL_SNMP_MAX_AGE_DAYS` old, 8 by default); the file only grows during an
  outage.
- Heartbeats that carry no `snmp` section (an agent without SNMP, or an empty
  queue) are exactly what they were before.

### Resources

Measured with pysnmp 7.1.30 on Python 3.13 (macOS): the agent alone peaks at about
36 MB; polling eight devices with 130 interfaces each over SNMPv3 peaked at about
82 MB with one worker and about 96 MB with four. The shipped unit's `MemoryMax=256M`
and `TasksMax=64` leave room for the default pool; raise them with a drop-in if you
raise `SENTINEL_SNMP_MAX_CONCURRENT_POLLS` to the maximum of 16. CPU use is
negligible next to the network wait.

### Testing

The agent's tests run without the SNMP libraries (the SNMP integration tests skip).
With them, they poll a simulated device over real SNMPv2c and SNMPv3 (every
SHA-2/AES combination, and the failure modes) using
[snmpsim](https://github.com/lextudio/snmpsim):

```bash
pip install "./agent[snmp]" snmpsim pysmi
python -m unittest agent.tests.test_snmp_integration -v
```

`snmpsim` uses `pysmi` without declaring it, hence the extra install. The server's
tests include the agent-to-server contract (`apps/snmp/tests/test_agent_contract.py`)
and, when the libraries are installed, a real end-to-end run of the agent against
snmpsim and a live server (`apps/snmp/tests/test_agent_e2e.py`).

### Limitations of the collector

- The devices file is edited by hand and read at start-up: restart the agent after
  changing it. Server-managed configuration is not implemented.
- Host names resolve to IPv4; use an IPv6 literal for an IPv6 device.
- SNMP traps and informs, SET requests, MIB files and custom OIDs are not
  supported.
- Counter state is kept in memory (see `first`).
- An SNMPv3 `context_name` other than the default is supported; per-VLAN
  community indexing (`community@vlan`) is not.
- Windows is not supported (the agent targets Linux and macOS).

## What is stored (server side)

| Model | Purpose | Written by |
| --- | --- | --- |
| **SNMP configuration** (`SnmpConfig`) | One per SNMP-monitored device: SNMP version (`2c` or `3`; v1 is not supported), port, poll interval (default 300 s, 30–86,400), request timeout (default 5 s), retries (default 1) and a **credential profile name** | Admin (inline on the device page) |
| **Device SNMP state** (`DeviceSnmpState`) | Latest state: reachable, last poll and last success time, response time, uptime, sysName, sysDescr, sysObjectID | Ingest |
| **Interface** | One per (device, `ifIndex`): name, description, alias, type, speed, admin and operational status, when the operational status last changed, whether it is still present | Ingest |
| **Device poll** (`DevicePoll`) | One row per poll: reachability, response time, uptime, error category. This is the reachability history | Ingest |
| **Interface sample** (`InterfaceSample`) | Counters of one interface at one poll: **raw counters and the calculated deltas**, status, speed | Ingest |

Configuration lives under **Inventory → Devices** (the SNMP section of a
device); everything else is visible, read-only, under **SNMP** in the admin.
Nothing written by agents can be edited or deleted by hand.

A device is accepted for SNMP reports only if it is **enabled**, **assigned to
the reporting agent**, and **has an SNMP configuration**.

## Credentials are never stored

Sentinel never stores SNMP community strings or SNMPv3 keys:

- The only credential-related field is `credential_profile`, a *name*
  (letters, digits, `.`, `_`, `-`) that refers to a profile in the agent's
  local credentials file, which stays on the agent host.
- No model or form has a field that could hold a secret (this is enforced by a
  test), and any extra field in a payload is ignored and never stored. Error
  messages never repeat payload values.
- Supported: SNMPv2c and SNMPv3. Not supported, by design: SNMPv1, MD5
  authentication and DES privacy. SNMPv2c sends its community in clear text
  over the network; prefer SNMPv3 with authentication and privacy.

## The `snmp` heartbeat section (version 1)

An optional section next to `telemetry`, `docker` and `network`. It is
validated and applied independently: an invalid `snmp` section never blocks
liveness or the other sections, and a heartbeat without it behaves exactly as
before.

```json
{
  "snmp": {
    "version": 1,
    "polls": [
      {
        "poll_id": "6f1c0c1e-6d7f-4c57-9d52-6f6f3f8b5f10",
        "device_id": "0b8f0a5e-2f0e-4c1c-8f65-1e0d4f0d7d2a",
        "measured_at": "2026-10-12T14:05:00+00:00",
        "reachable": true,
        "response_ms": 12.5,
        "error": "",
        "sys_uptime_ticks": 8123456,
        "system": {
          "name": "core-sw-1",
          "descr": "Cisco IOS XE Software, Version 17.9.4",
          "object_id": "1.3.6.1.4.1.9.1.2504"
        },
        "interfaces_complete": false,
        "interfaces": [
          {
            "if_index": 3,
            "name": "Gi0/3",
            "descr": "GigabitEthernet0/3",
            "alias": "uplink to dc2",
            "if_type": 6,
            "speed_bps": 1000000000,
            "admin_status": 1,
            "oper_status": 1,
            "counters": {
              "octets_bits": 64,
              "delta_state": "ok",
              "interval_seconds": 300.1,
              "raw":   {"in_octets": 18273645, "out_octets": 9918273, "in_errors": 0, "out_errors": 0, "in_discards": 0, "out_discards": 0},
              "delta": {"in_octets": 300000,   "out_octets": 150000,  "in_errors": 0, "out_errors": 0, "in_discards": 0, "out_discards": 0}
            }
          }
        ]
      }
    ]
  }
}
```

### Poll fields

`version` must be the integer `1`.

| Field | Rules |
| --- | --- |
| `poll_id` | UUID chosen by the agent; the **idempotency key** |
| `device_id` | UUID of the device (shown in the admin); must be assigned to the reporting agent |
| `measured_at` | ISO-8601 time of the poll (naive means UTC). At most 5 minutes in the future, and not older than the acceptance window (see below). A device has at most one poll per `measured_at` |
| `reachable` | `true` or `false` |
| `response_ms` | Optional number 0–600,000 |
| `error` | Empty when reachable; otherwise one of `timeout`, `unreachable`, `auth_failure`, `dns_failure`, `protocol_error`, `unsupported`, `unknown` (or empty) |
| `sys_uptime_ticks` | Optional integer 0–2³²−1 (`sysUpTime`, hundredths of a second) |
| `system` | Optional `name`, `descr`, `object_id` (dotted OID). Text is cleaned (control characters become spaces) and truncated, never rejected |
| `interfaces_complete` | `true` if `interfaces` lists **every** interface of the device (a discovery poll). Interfaces missing from it are then marked absent |
| `interfaces` | List (at most 512 per poll); each `if_index` once |

An **unreachable** poll must not carry `system`, `sys_uptime_ticks`,
`interfaces` or `interfaces_complete`.

### Interface fields

`if_index` (1–2³¹−1), `name` (≤ 255; if it is blank the server uses `descr`, then
`if<ifIndex>`, so a device's odd text never costs a poll), optional `descr`, `alias`,
`if_type` (IANAifType number), `speed_bps` (0–10¹⁵ or null), `admin_status`
(1 up, 2 down, 3 testing) and `oper_status` (1 up, 2 down, 3 testing,
4 unknown, 5 dormant, 6 notPresent, 7 lowerLayerDown) — both required.

`counters` is optional: an interface without it only updates the inventory
(for example the interfaces an agent discovers but does not monitor) and gets
no sample.

### Counters: raw values and deltas

The agent reads the counters, calculates the increase since its previous poll
(handling wraps), and sends **both**. The server stores both, so deltas can be
recomputed from the raw values later.

- `octets_bits`: `64` when the 64-bit `ifHC*` octet counters were used (preferred),
  `32` otherwise. Error and discard counters are always 32-bit.
- `raw`: each counter, or null when the device does not provide it. Raw values
  are limited to 2⁶³−1 (a 64-bit counter needs about 23 years at 100 Gbit/s to
  get there).
- `delta_state` says whether the deltas can be trusted:

| `delta_state` | Meaning | `delta` | `interval_seconds` |
| --- | --- | --- | --- |
| `ok` | Deltas valid | object, each value ≤ the counter width (or null, but only where `raw` is present) | required, > 0 |
| `speed_changed` | Deltas valid, but the interface speed changed during the interval, so a utilization calculated from them is approximate | as `ok` | required |
| `first` | No previous counters | must be empty | optional (`0` means unknown) |
| `reboot` | The device restarted (uptime went backwards) | must be empty | optional (`0` means unknown) |
| `reset` | A counter went backwards without wrapping | must be empty | optional (`0` means unknown) |
| `gap` | The previous sample is too old for a meaningful delta | must be empty | optional (`0` means unknown) |

Bandwidth utilization is not stored: it is `delta × 8 ÷ interval_seconds ÷ speed_bps`
(the sample keeps the speed it was measured with).

### Limits

At most 50 polls and 2,000 interfaces per report; 512 interfaces per poll. A
larger report is rejected as a whole; a single invalid poll is rejected on its
own. A poll with any invalid interface value is rejected as a whole (the reason
names the interface), so the collector should send `null` rather than an
out-of-range value.

## Acknowledgement

The response mirrors the network acknowledgement, with `snmp_` keys:

```json
{
  "status": "ok",
  "snmp": "accepted",
  "snmp_created": 1,
  "snmp_duplicates": 0,
  "snmp_accepted": 1,
  "snmp_rejected": 0,
  "snmp_results": [{"poll_id": "6f1c0c1e-…", "result": "created"}]
}
```

`snmp` is `accepted`, `partial` or `rejected`. Each entry of `snmp_results` is
`created`, `duplicate` (already stored: safe to forget) or `rejected` with a
`reason` and `retryable`:

- `retryable: false`: the data itself is invalid (a bad value, a poll that
  conflicts with a stored one). Resending the same poll can never succeed.
- `retryable: true`: it depends on the server's state or clock, so a later
  resend can succeed: the device does not exist yet, is not assigned to this
  agent yet, is disabled or has no SNMP configuration (an operator may fix
  that after the agent started polling), the poll's time is slightly ahead of
  the server's clock, or the server failed to store the poll.

If the database is unavailable the heartbeat fails with an HTTP error and
**nothing is acknowledged**. An envelope problem (wrong version, too many
polls, …) rejects the section with `snmp_detail` and no `snmp_results`.

The agent removes a queued poll only when it is `created`, `duplicate`, or
rejected with `retryable: false`, and keeps the others for a later heartbeat
(bounded by its own queue age and attempt limits).

## Guarantees

- **Idempotent**: a poll that is already stored (same `poll_id`, device and
  time) is acknowledged as a duplicate and not stored again, whichever agent
  resends it, for example a recreated agent resending its queue. A reused
  `poll_id` with another device or another time is rejected as a conflict, so
  its data is never silently dropped; so is a *different* poll for the same
  device and time.
- **Late and out-of-order polls** are stored as history, and the final state
  does not depend on delivery order. Two freshness rules apply: the
  *reachability* state of a device (reachable, error, response time, uptime)
  follows the newest poll, reachable or not; the *data* that reachable polls
  carry (system information, interfaces, `last_success_at`) follows the newest
  reachable poll. A newer unreachable poll therefore does not hide newer
  interface data that arrives late. "Absent" decisions follow the discovery
  poll's time: an interface first seen in a poll older than the latest complete
  listing is created absent.
- **All or nothing per poll**: its history row, samples, interface changes and
  the device state are stored together or not at all. A failure for one poll
  does not affect the others in the same report.
- **Safe under concurrency**: each report first locks the devices it touches
  and their state rows, always in the same (primary-key) order, and holds the
  locks until it commits, so overlapping reports (a retry of a request that
  timed out, the next heartbeat) cannot deadlock or interleave.
- **Ownership**, checked at validation and again under the device lock, so a
  device reassigned, disabled or deleted in between is not written to (the poll
  is rejected as retryable). Another agent's device and a nonexistent device
  give the same rejection, so an agent learns nothing about devices that are
  not its own. Poll rows do not record the agent: it is always the one the
  device was assigned to.
- **Efficient**: a fixed number of queries per report however many polls and
  interfaces it carries (measured: 1 to validate, then 12 to store in steady
  state and 14 for a first report that also creates the interfaces, for 10
  devices with 24 interfaces each, locks and savepoints included); unchanged
  interfaces are not rewritten.
- **Delayed polls** are accepted if not older than `SENTINEL_SNMP_MAX_AGE_DAYS`
  (default 8, never more than the retention period). Keep the agent's queue age
  below it.

## Retention and database growth

```bash
python manage.py purge_snmp_data [--days N] [--batch-size N] [--dry-run]
```

Run it daily (see "Scheduling the cleanup" in the README). It deletes polls and
interface samples older than `SENTINEL_SNMP_RETENTION_DAYS` (default 30) in
batches, then the interfaces that are absent from their device and have no
samples left. Nothing runs automatically, and heartbeats never trigger it.

The interface sample table is the largest in the system. Measured on a
synthetic table of 4 million samples (raw counters and deltas): about 225 bytes
per row including its primary-key and unique indexes. The index on
`measured_at` is a BRIN index (40 KB for 4 million rows, where a btree would
add about 86 MB): it makes the purge's "anything older than the cutoff?" query
take under a millisecond instead of scanning the table.

Rows per day = monitored interfaces × polls per day. Estimates (not measured
in production):

| Monitored interfaces | Poll interval | Rows per 30 days | Approximate size |
| ---: | ---: | ---: | ---: |
| 200 | 300 s | 1.7 M | 0.4 GB |
| 1,000 | 300 s | 8.6 M | 1.9 GB |
| 2,000 | 300 s | 17.3 M | 3.9 GB |
| 2,000 | 60 s | 86 M | 19 GB |

Keep the monitored interfaces to the ones that matter, and keep 300 s unless you
need more. Partitioning and long-term rollups are not implemented.

## Deleting devices

Polling history is never deleted implicitly. A device that has history cannot
be deleted (the admin says so, without trying to list the history): disable it,
and delete it once `purge_snmp_data` has removed its history. Deleting an
**agent** keeps all history and only unassigns its devices; history rows do not
reference the agent, so this never scans or rewrites them, however large they
are.

## Limitations

- `ifIndex` values are not guaranteed to survive a device reboot on every
  vendor. If a device renumbers its interfaces, the old interfaces become absent
  and new ones appear.
- `oper_status_changed_at` is the time of the poll that first reported the new
  status *as delivered*. With out-of-order delivery it can be later than the real
  transition; the exact transition is visible in the sample history. Agents
  deliver oldest first, so this only matters after outages.
- Interface and sample lists in the admin show an estimated total (from
  PostgreSQL's statistics) when they are large and unfiltered, instead of a
  `COUNT(*)` over millions of rows; filtered and small lists are exact.
- The retention command and ingest can race on an absent interface that is
  listed again at the very moment it is purged; at worst one request fails and
  the agent retries.

## Upgrade notes

- The tables are new; no existing table changed, and migrations are additive.
- Server first: an agent that sends an `snmp` section to a server without this
  release gets no `snmp_*` acknowledgement, keeps its queue and pauses SNMP
  batches with backoff (everything else keeps working). Upgrade the server, then
  the agents.
- Agents: install the `[snmp]` extra and add the two configuration files. Agents
  without them are unaffected, and an agent upgrade does not change the queue file's
  schema version, so a downgrade keeps working (an older agent leaves queued SNMP
  polls in the file untouched).
