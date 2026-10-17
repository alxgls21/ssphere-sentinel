# Agent deployment on Linux (systemd)

This guide installs the SSphere Sentinel agent on a monitored Linux host as a
hardened systemd service. The agent is a separate, lightweight distribution
(`ssphere-sentinel-agent`): it needs Python and `psutil`, and nothing from the
server (no Django, Gunicorn or PostgreSQL driver).

| Item | Location |
| --- | --- |
| Service account | `sentinel-agent` (system user, no login shell) |
| Virtual environment (code, read-only for the service) | `/opt/ssphere-sentinel-agent/venv` |
| Configuration and token (root only, `0600`) | `/etc/ssphere-sentinel-agent/agent.env` |
| Network targets file (`root:sentinel-agent`, `0640`) | `/etc/ssphere-sentinel-agent/network_targets.json` |
| SNMP devices and credentials files, if SNMP is used (`root:sentinel-agent`, `0640`) | `/etc/ssphere-sentinel-agent/snmp_devices.json`, `snmp_credentials.json` |
| Persistent queue of measurements and SNMP polls (`0700` directory) | `/var/lib/ssphere-sentinel-agent/` |
| Unit file | `/etc/systemd/system/sentinel-agent.service` |
| Unprivileged ICMP for the agent's group (if needed) | `/etc/sysctl.d/60-ssphere-sentinel-agent-icmp.conf` |
| Logs | journald: `journalctl -u sentinel-agent` |

The shipped files are in [`deploy/systemd/`](../deploy/systemd/): the unit, an
environment template, the ICMP helper script and an opt-in Docker drop-in. Replace `<tag>` below with
the release you deploy (for example `v0.2.0`).

## Requirements

- Linux with systemd 247 or newer (Debian 11+, Ubuntu 22.04+, RHEL 9+). Older
  versions ignore the newest hardening options and log a warning.
- Python 3.11 or newer with `venv`:
  - Debian 12: `sudo apt install python3-venv` (Python 3.11)
  - Ubuntu 24.04: `sudo apt install python3-venv` (Python 3.12)
  - Ubuntu 22.04: `sudo apt install python3.11 python3.11-venv`, then use
    `python3.11` instead of `python3` below
  - RHEL 9 and compatible: `sudo dnf install python3.12`, then use `python3.12`
- `ping` (`iputils-ping` on Debian/Ubuntu) for ICMP targets, and unprivileged
  ICMP allowed for the agent's group ([step 4](#4-allow-icmp-probes)); Debian
  and Ubuntu disable it by default.
- `git`, only if you install directly from the repository.
- Outbound HTTPS from the host to the Sentinel server.

## 1. Create the agent on the server

In the Django admin, add an **Agent** for the host's **Server** (or run
`python manage.py create_agent --server <server-uuid> --name <name>`). The
token is displayed **once**; keep it for step 3. For network monitoring,
also create the **Network targets** assigned to this agent and note their
UUIDs.

## 2. Install

```bash
sudo useradd --system --home-dir /var/lib/ssphere-sentinel-agent --no-create-home \
    --shell /usr/sbin/nologin sentinel-agent

sudo python3 -m venv /opt/ssphere-sentinel-agent/venv
sudo /opt/ssphere-sentinel-agent/venv/bin/pip install \
    "ssphere-sentinel-agent @ git+https://github.com/alxgls21/ssphere-sentinel@<tag>#subdirectory=agent"
```

Without `git` or internet access on the host, prepare the wheels on another
machine with the same OS, CPU architecture and Python version (`psutil` is a
binary wheel): `python -m pip wheel --wheel-dir dist ./agent` in a checkout,
copy `dist/` over and install with
`sudo /opt/ssphere-sentinel-agent/venv/bin/pip install --no-index --find-links ./dist ssphere-sentinel-agent`.

The virtual environment is owned by root: the service can read but not modify
its own code.

## 3. Configure

Fetch the deployment files for the same release:

```bash
for file in sentinel-agent.service agent.env.example enable-unprivileged-icmp.sh docker-monitoring.conf; do
    curl -fsSLO "https://raw.githubusercontent.com/alxgls21/ssphere-sentinel/<tag>/deploy/systemd/$file"
done
```

Install the environment file with root-only permissions and edit it:

```bash
sudo install -d -m 0755 /etc/ssphere-sentinel-agent
sudo install -m 0600 -o root -g root agent.env.example /etc/ssphere-sentinel-agent/agent.env
sudoedit /etc/ssphere-sentinel-agent/agent.env
```

Set at least `SENTINEL_URL` (the `https://` address of the server) and
`SENTINEL_AGENT_TOKEN`. systemd reads this file as root before it starts the
agent, so the token is never readable by the service account from disk,
never on a command line and never in the unit file.

For network monitoring, create a targets file (format:
[`agent/network_targets.example.json`](../agent/network_targets.example.json);
each `id` is a target UUID from step 1), install it and enable it in
`agent.env` with `SENTINEL_NETWORK_TARGETS_FILE=/etc/ssphere-sentinel-agent/network_targets.json`:

```bash
sudo install -m 0640 -o root -g sentinel-agent network_targets.json \
    /etc/ssphere-sentinel-agent/network_targets.json
```

## 4. Allow ICMP probes

Skip this step if the agent has no ICMP targets.

The unit gives the agent **no Linux capabilities** (`NoNewPrivileges=yes`, an
empty `CapabilityBoundingSet=`), so `ping` cannot use the `CAP_NET_RAW` file
capability it relies on on Debian and Ubuntu. Instead it uses the kernel's
unprivileged ICMP sockets, which only groups within
`net.ipv4.ping_group_range` may open. Debian and Ubuntu leave that range at
the kernel default `1 0` (no group); some other distributions allow all
groups. Allow exactly the agent's group:

```bash
sudo sh enable-unprivileged-icmp.sh
```

The script writes `/etc/sysctl.d/60-ssphere-sentinel-agent-icmp.conf`
(`net.ipv4.ping_group_range = <gid> <gid>` for the `sentinel-agent` group),
applies it immediately, and checks that the kernel now allows the group;
systemd re-applies it at every boot. It changes nothing if the group is
already allowed, and it never replaces a range that is already active or set
in another sysctl file (it stops and asks you to extend that range yourself).
If the kernel does not accept the setting (for example inside a container), it
removes the file again and exits with an error. Each outcome prints one line;
an exit status other than 0 always comes with an `error:` message. See
[security.md](security.md#unprivileged-icmp) for exactly what this permits.

Without this step ICMP measurements are recorded with
`failure_reason=permission_denied` and the journal shows once:
`WARNING: ICMP probes are not permitted (ping: socket: Operation not permitted ...)`.

## 5. Start

```bash
sudo install -m 0644 sentinel-agent.service /etc/systemd/system/sentinel-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now sentinel-agent
```

`enable` starts the agent at boot, after the network is online. systemd
restarts it 10 seconds after a crash. On `systemctl stop` the agent stops
probing, lets running probes finish, keeps queued measurements on disk and
exits cleanly.

## 6. Check

```bash
systemctl status sentinel-agent
journalctl -u sentinel-agent -f          # follow the log
journalctl -u sentinel-agent -p warning  # problems only
```

A healthy start logs two lines, then stays quiet:

```text
INFO: SSphere Sentinel agent 0.1.0 starting: server https://sentinel.example.com, heartbeat every 30s
INFO: Network monitoring: 3 enabled target(s), queue /var/lib/ssphere-sentinel-agent/network-queue.sqlite3
```

Successful heartbeats are not logged at the default `INFO` level; failures
are (`WARNING: Heartbeat failed: ...`), and so is the first success after
failures. In the admin, the server's **Last seen** updates every heartbeat.

To send a single heartbeat by hand as the service account, with the same
environment (the token stays in the file):

```bash
sudo systemd-run --pty --quiet --uid=sentinel-agent --gid=sentinel-agent \
    -p EnvironmentFile=/etc/ssphere-sentinel-agent/agent.env \
    -p Environment=SENTINEL_QUEUE_PATH=/var/lib/ssphere-sentinel-agent/network-queue.sqlite3 \
    /opt/ssphere-sentinel-agent/venv/bin/sentinel-agent heartbeat
```

## Docker monitoring (optional)

Docker discovery is off unless you enable it. It needs the Docker SDK and
access to the Docker API, and access to the Docker API is **equivalent to root
on the host**: whoever can use it can start a privileged container. The agent
only reads container metadata (names, images, state, health; never
environment variables, mounts, commands or logs), but the permission is what
matters if the service account is ever compromised.

Install the extra in both cases:

```bash
sudo /opt/ssphere-sentinel-agent/venv/bin/pip install \
    "ssphere-sentinel-agent[docker] @ git+https://github.com/alxgls21/ssphere-sentinel@<tag>#subdirectory=agent"
```

### Recommended: read-only socket proxy

A filtering proxy owns the socket and only allows the read-only endpoints the
agent uses (`/_ping`, `/version`, container and image inspection):

```bash
docker run -d --name sentinel-docker-proxy --restart unless-stopped \
    -p 127.0.0.1:2375:2375 \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -e CONTAINERS=1 -e IMAGES=1 -e POST=0 \
    ghcr.io/tecnativa/docker-socket-proxy:v0.5.0
```

Then add `DOCKER_HOST=tcp://127.0.0.1:2375` to `agent.env` and restart the
agent. Any local user can read container metadata through the proxy, but
nobody can change anything. If SELinux or AppArmor blocks the proxy's socket
access, follow the proxy's documentation (it may need `--privileged`).

### Simple: direct socket access

```bash
sudo install -D -m 0644 docker-monitoring.conf \
    /etc/systemd/system/sentinel-agent.service.d/docker-monitoring.conf
sudo systemctl daemon-reload
sudo systemctl restart sentinel-agent
```

This adds the service account to the `docker` group for the service only,
with the root-equivalent implications above. Rootless Docker or Podman
sockets work the same way through `DOCKER_HOST`.

The journal shows `Docker discovery available` once it works, or
`Docker discovery unavailable (permission_denied)` once per state change.

### Docker reports too large for a heartbeat

A heartbeat is never larger than 2,500,000 bytes. A container takes about 300
bytes in the report (up to about 900 with the longest names and images), and
Sentinel accepts up to 1,000 containers per host, so a report that Sentinel can use
fits with room to spare, next to the telemetry and everything else the heartbeat
carries. If one does not, or lists more than 1,000 containers (Sentinel would
reject it whole, however small), the agent:

- leaves the report out of that heartbeat **whole**. It never sends part of it:
  a partial snapshot would mark the containers it leaves out as absent;
- logs `The Docker report cannot be sent: ...` as an error at every heartbeat,
  with the size of the heartbeat or the number of containers, and the limit;
- sends everything else as usual (liveness, telemetry, network measurements and
  SNMP polls); nothing queued is dropped.

Sentinel's inventory for the host is not touched. Its containers keep their
last-known values and read `unknown` in the console once the inventory is older than
`SENTINEL_OFFLINE_THRESHOLD` (90 seconds by default). The agent judges the report
afresh at every heartbeat, so the inventory is current again with the first report
that fits: remove stopped containers (`docker container prune`) or spread the
workload over more hosts.

## SNMP monitoring (optional)

The agent can poll network devices (switches, routers, firewalls) over SNMPv2c
and SNMPv3 and report their reachability, interfaces and counters. It is off
unless you configure it, and the full reference (every setting, the credential
rules, counters, limits) is in [snmp.md](snmp.md). On the agent host:

1. Create the device in Sentinel (**Inventory → Devices**, assigned to this
   agent, with an SNMP section naming a credential profile) and note its UUID.
2. Install the extra (it adds `pysnmp` and `cryptography`):

   ```bash
   sudo /opt/ssphere-sentinel-agent/venv/bin/pip install \
       "ssphere-sentinel-agent[snmp] @ git+https://github.com/alxgls21/ssphere-sentinel@<tag>#subdirectory=agent"
   ```

3. Write the credentials file and the devices file (formats in
   [snmp.md](snmp.md#quick-start)). The credentials file holds community strings and
   SNMPv3 keys, so give it the same permissions as the targets file and no wider:

   ```bash
   sudo install -m 0640 -o root -g sentinel-agent snmp_credentials.json /etc/ssphere-sentinel-agent/snmp_credentials.json
   sudo install -m 0640 -o root -g sentinel-agent snmp_devices.json /etc/ssphere-sentinel-agent/snmp_devices.json
   ```

   The agent refuses a credentials file that other users can access, that group or
   others can write, that is a symlink, or that belongs to another user.

4. Enable it in `agent.env` and restart:

   ```ini
   SENTINEL_SNMP_DEVICES_FILE=/etc/ssphere-sentinel-agent/snmp_devices.json
   SENTINEL_SNMP_CREDENTIALS_FILE=/etc/ssphere-sentinel-agent/snmp_credentials.json
   ```

   ```bash
   sudo systemctl restart sentinel-agent
   ```

The journal then shows `SNMP monitoring: N enabled device(s), 4 concurrent poll(s)
at most`, followed by one warning per weak credential profile (SNMPv2c, default
communities, authentication without privacy, SHA-1), and once per device that is
unreachable. Use SNMPv3 with SHA-256 or stronger and AES, and read-only SNMP users.

Network requirements: UDP to each device's SNMP port (161), outbound from the
agent host; the unit's `RestrictAddressFamilies` already includes IPv4 and IPv6.
With the default pool of four workers, SNMP adds about 50 to 60 MB to the agent's
memory (measured on macOS; `MemoryMax=256M` leaves room).

The server must be a release with SNMP support before the agent sends its first
poll; until then polls stay queued and the rest of the agent is unaffected.

## Upgrades

```bash
sudo /opt/ssphere-sentinel-agent/venv/bin/pip install --upgrade \
    "ssphere-sentinel-agent @ git+https://github.com/alxgls21/ssphere-sentinel@<new-tag>#subdirectory=agent"
sudo systemctl restart sentinel-agent
```

(Add `[docker]` and/or `[snmp]`, as `[docker,snmp]`, after the package name if you use Docker or SNMP monitoring.) Compare
the new release's `deploy/systemd/sentinel-agent.service` with the installed
one; if it changed, reinstall it and run `sudo systemctl daemon-reload` before
the restart. Queued measurements survive the restart and are sent afterwards.
Downgrading is possible, but an older agent ignores a queue file created by a
newer one (it falls back to an in-memory queue and logs a warning).

**Upgrading from a release before the packaging split** (where the agent was
installed with the whole `ssphere-sentinel` package): uninstall that package
first, otherwise removing it later deletes files the agent now owns.

```bash
sudo /opt/ssphere-sentinel-agent/venv/bin/pip uninstall -y ssphere-sentinel
```

## Token rotation

1. In the admin, select the agent and run **Regenerate authentication
   token**, confirm, and copy the new token from the page (it is shown once).
2. Replace `SENTINEL_AGENT_TOKEN` in `/etc/ssphere-sentinel-agent/agent.env`.
3. `sudo systemctl restart sentinel-agent`.

The old token stops working at step 1. Until step 3 heartbeats fail with
HTTP 401; network measurements stay queued and are delivered afterwards.

## Changing the hardening

Use a drop-in (`sudo systemctl edit sentinel-agent`) rather than editing the
unit, so upgrades can replace it. For example, debug logging:

```ini
[Service]
Environment=SENTINEL_LOG_LEVEL=DEBUG
```

Raise `MemoryMax=` or `TasksMax=` the same way for hosts with many containers
or targets. `systemd-analyze security sentinel-agent` summarizes the sandbox.

## Troubleshooting

| Symptom (journal) | Cause and fix |
| --- | --- |
| `Heartbeat failed: server returned HTTP 401` | Wrong or rotated token, or the agent is disabled in the admin. Update `agent.env` and restart. |
| `server returned HTTP 301 redirect; redirects are not followed` | `SENTINEL_URL` is not the final address (for example `http://` behind an HTTPS redirect). Use the `https://` URL. |
| `connection failed: ...` / `request timed out` | DNS, firewall or the server is down. The agent keeps retrying; measurements stay queued. |
| `Heartbeat failed: server returned HTTP 403` behind Cloudflare | A WAF, Bot Fight Mode or Access rule blocks the agent. Exempt `/api/v1/agent/` (docs/server-deployment.md). |
| ICMP measurements with `permission_denied`; `ICMP probes are not permitted` in the journal | Unprivileged ICMP is not allowed for the agent's group (the warning shows the current `net.ipv4.ping_group_range` and the agent's groups). Run `sudo sh enable-unprivileged-icmp.sh` ([step 4](#4-allow-icmp-probes)); no restart is needed. Do not add `CAP_NET_RAW` to the unit instead. |
| `Network queue storage unavailable ... using in-memory queue` | The state directory was created with wrong ownership. `sudo systemctl stop sentinel-agent && sudo chown -R sentinel-agent: /var/lib/ssphere-sentinel-agent && sudo chmod 0700 /var/lib/ssphere-sentinel-agent`, then start. |
| `Network target configuration error` | Invalid targets file or unreadable by `sentinel-agent` (needs `0640 root:sentinel-agent`). |
| `SNMP monitoring disabled: ...` | The message says why: a configuration error (the file and field are named, never a secret), a credentials file with too-open permissions, or `pysnmp is not installed` (install the `[snmp]` extra). The rest of the agent keeps running. |
| `SNMP device ... is unreachable: timeout` | No answer from the device: wrong address or port, a firewall, or (SNMPv2c) a wrong community, which devices answer with silence. `auth_failure` means a wrong SNMPv3 user, key or protocol. See [snmp.md](snmp.md#unreachable-devices). |
| `Sentinel could not accept N SNMP poll(s) yet` | The device is not created, assigned to this agent, enabled or configured for SNMP in Sentinel. Polls are kept and retried; fix the device in the admin. |
| `Heartbeat failed: server returned HTTP 413 (request body N bytes)` (or `HTTP 400 (request body N bytes)`) | A reverse proxy or WAF in front of Sentinel refuses bodies of that size. The agent sends at most 2,500,000 bytes and keeps its queues; raise the limit of the proxy to at least 3 MB ([server-deployment.md](server-deployment.md#request-body-size)). |
| `SNMP poll ... cannot be sent and is removed from the queue` | One queued poll is larger than any request can be (more than 2,500,000 bytes as sent). It is dropped and the polls behind it go on; the message gives its size. See [snmp.md](snmp.md#request-size). |
| `The Docker report cannot be sent: with the telemetry it makes a heartbeat of N bytes, over the limit` | The Docker inventory alone exceeds the request limit (thousands of containers; Sentinel accepts 1,000). It is left out whole at every heartbeat and the rest is sent; see [Docker reports too large for a heartbeat](#docker-reports-too-large-for-a-heartbeat). |
| `Heartbeat failed: the heartbeat is N bytes (telemetry=..., ...), over the limit` or `the network section is N bytes` | A section other than Docker is larger than a request can be. Nothing was sent and nothing queued was touched. The sizes in the message name the section; this is not expected, so report it. |
| Service restarts in a loop | `journalctl -u sentinel-agent -n 50`; usually a configuration error (`Agent failed: SENTINEL_URL is not set`). |

## Uninstall

```bash
sudo systemctl disable --now sentinel-agent
sudo rm -rf /etc/systemd/system/sentinel-agent.service /etc/systemd/system/sentinel-agent.service.d
sudo systemctl daemon-reload
sudo rm -rf /opt/ssphere-sentinel-agent /etc/ssphere-sentinel-agent /var/lib/ssphere-sentinel-agent
sudo userdel sentinel-agent
# If step 4 wrote it: remove the ICMP drop-in and restore the kernel default.
sudo rm -f /etc/sysctl.d/60-ssphere-sentinel-agent-icmp.conf
sudo sysctl -w net.ipv4.ping_group_range="1 0"
sudo sysctl --system
```

Removing `/var/lib/ssphere-sentinel-agent` deletes measurements that were not
delivered yet.

## macOS

The agent runs on macOS (`pip install` into a virtual environment, then
`sentinel-agent run`), for example under `launchd`; a ready-made launchd
service is not provided yet.
