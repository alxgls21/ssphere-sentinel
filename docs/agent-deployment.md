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
| Persistent measurement queue (`0700` directory) | `/var/lib/ssphere-sentinel-agent/` |
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

## Upgrades

```bash
sudo /opt/ssphere-sentinel-agent/venv/bin/pip install --upgrade \
    "ssphere-sentinel-agent @ git+https://github.com/alxgls21/ssphere-sentinel@<new-tag>#subdirectory=agent"
sudo systemctl restart sentinel-agent
```

(Add `[docker]` after the package name if you use Docker monitoring.) Compare
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
