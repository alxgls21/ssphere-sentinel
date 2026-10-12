# SSphere Sentinel agent

Lightweight host agent for [SSphere Sentinel](https://github.com/alxgls21/ssphere-sentinel),
a self-hosted infrastructure and network monitoring platform.

The agent runs on monitored Linux or macOS hosts and sends authenticated
heartbeats to a Sentinel server, with host telemetry (CPU, memory, disk,
uptime), ICMP/TCP network measurements from a persistent local queue, and
optional Docker container discovery.

It does **not** depend on Django, Gunicorn or a PostgreSQL driver: its only
required dependency is `psutil`.

## Installation

Python 3.11 or newer is required.

```bash
# Agent only
pip install "ssphere-sentinel-agent @ git+https://github.com/alxgls21/ssphere-sentinel@<tag>#subdirectory=agent"

# With optional Docker discovery (installs the Docker SDK)
pip install "ssphere-sentinel-agent[docker] @ git+https://github.com/alxgls21/ssphere-sentinel@<tag>#subdirectory=agent"
```

From a source checkout: `pip install ./agent` (or `pip install "./agent[docker]"`).

For production Linux hosts, follow the systemd deployment guide:
<https://github.com/alxgls21/ssphere-sentinel/blob/main/docs/agent-deployment.md>
(dedicated service account, hardened unit, persistent queue directory).

## Usage

```bash
export SENTINEL_URL=https://sentinel.example.com
export SENTINEL_AGENT_TOKEN=<token>   # never pass the token as a CLI argument

sentinel-agent heartbeat   # one-shot heartbeat (exit code 0 on success)
sentinel-agent run         # continuous foreground loop (stops on SIGINT/SIGTERM)
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTINEL_URL` | required | Sentinel server base URL (`https://` expected; redirects are not followed) |
| `SENTINEL_AGENT_TOKEN` | required | Agent token printed once by `manage.py create_agent` |
| `SENTINEL_HEARTBEAT_INTERVAL` | `30` | Seconds between heartbeats |
| `SENTINEL_NETWORK_TARGETS_FILE` | unset | JSON file with network targets (see `network_targets.example.json`) |
| `SENTINEL_QUEUE_PATH` | `$XDG_STATE_HOME/ssphere-sentinel/network-queue.sqlite3` | Absolute path of the persistent measurement queue |
| `SENTINEL_QUEUE_MAX_MEASUREMENTS` | `10000` | Queue size limit (oldest dropped first) |
| `SENTINEL_QUEUE_MAX_AGE_SECONDS` | `604800` | Unsent measurements older than this are discarded |
| `SENTINEL_NETWORK_MAX_CONCURRENT_PROBES` | `4` | Probe worker threads (1–16) |
| `SENTINEL_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR` |

Full protocol and behaviour documentation:
<https://github.com/alxgls21/ssphere-sentinel#readme>

## License

GNU Affero General Public License v3.0 — see `LICENSE`.
