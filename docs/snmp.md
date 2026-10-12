# SNMP data (server side)

This document describes how the Sentinel server stores and accepts SNMP poll
results. **The agent-side SNMP collector is not implemented yet**: no agent
sends this data today, and existing agents and heartbeats are unaffected. The
payload below is the contract the collector will implement.

## What is stored

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
- Server first: a future agent that sends an `snmp` section to a server without
  this release gets no `snmp_*` acknowledgement and keeps its queue.
