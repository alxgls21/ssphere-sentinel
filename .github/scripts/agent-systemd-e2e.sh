#!/usr/bin/env bash
# End-to-end test of the documented agent deployment (docs/agent-deployment.md):
# install the agent into /opt with the system Python, run it under the shipped
# hardened systemd unit against the Compose server, and verify that liveness,
# telemetry and ICMP/TCP measurements arrive. Run as root on a disposable
# machine (CI runner) with the Compose stack up.
set -euo pipefail
cd "$(dirname "$0")/../.."

# --verbosity 0: no "objects imported automatically" banner from shell.
manage() { docker compose exec -T web python manage.py "$@" --verbosity 0; }
fail() {
    echo "FAIL: $*" >&2
    journalctl -u sentinel-agent --no-pager || true
    exit 1
}

echo "--- register a server, agent and two network targets"
read -r TOKEN TCP_ID ICMP_ID < <(manage shell -c '
from apps.agents.services import create_agent
from apps.infrastructure.models import Server
from apps.network.models import NetworkTarget
server = Server.objects.create(name="ci-agent-host", hostname="ci.local")
agent, token = create_agent(server=server, name="ci-agent")
common = {"hostname_or_ip": "127.0.0.1", "monitoring_interval_seconds": 10, "assigned_agent": agent}
tcp = NetworkTarget.objects.create(name="web-tcp", protocol="tcp", port=8000, **common)
icmp = NetworkTarget.objects.create(name="loopback-icmp", protocol="icmp", **common)
print(token, tcp.pk, icmp.pk)
')
[ -n "${ICMP_ID:-}" ] || fail "could not register the agent on the server"
echo "::add-mask::${TOKEN}"

echo "--- install as documented"
useradd --system --home-dir /var/lib/ssphere-sentinel-agent --no-create-home \
    --shell /usr/sbin/nologin sentinel-agent
if ! python3 -m venv /opt/ssphere-sentinel-agent/venv; then
    apt-get update -q && apt-get install -y -q python3-venv
    python3 -m venv /opt/ssphere-sentinel-agent/venv
fi
/opt/ssphere-sentinel-agent/venv/bin/pip install --quiet --disable-pip-version-check ./agent

install -d -m 0755 /etc/ssphere-sentinel-agent
cat > /etc/ssphere-sentinel-agent/network_targets.json <<JSON
{"targets": [
  {"id": "${TCP_ID}", "name": "web-tcp", "hostname_or_ip": "127.0.0.1", "protocol": "tcp",
   "port": 8000, "monitoring_interval_seconds": 10, "probe_count": 2},
  {"id": "${ICMP_ID}", "name": "loopback-icmp", "hostname_or_ip": "127.0.0.1", "protocol": "icmp",
   "monitoring_interval_seconds": 10, "probe_count": 2}
]}
JSON
chown root:sentinel-agent /etc/ssphere-sentinel-agent/network_targets.json
chmod 0640 /etc/ssphere-sentinel-agent/network_targets.json

install -m 0600 -o root -g root /dev/null /etc/ssphere-sentinel-agent/agent.env
cat > /etc/ssphere-sentinel-agent/agent.env <<ENV
SENTINEL_URL=http://127.0.0.1:8000
SENTINEL_AGENT_TOKEN=${TOKEN}
SENTINEL_HEARTBEAT_INTERVAL=5
SENTINEL_NETWORK_TARGETS_FILE=/etc/ssphere-sentinel-agent/network_targets.json
ENV

install -m 0644 deploy/systemd/sentinel-agent.service /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/sentinel-agent.service
systemd-analyze security --no-pager sentinel-agent.service | tail -n 3 || true
systemctl enable --now sentinel-agent

echo "--- wait for data from the agent"
status=""
for _ in $(seq 90); do
    status=$(manage shell -c '
import json
from apps.agents.models import Agent
from apps.network.models import NetworkMeasurement
agent = Agent.objects.select_related("server").get(name="ci-agent")
measurements = NetworkMeasurement.objects.filter(agent=agent)
print(json.dumps({
    "seen": agent.last_seen_at is not None,
    "telemetry": hasattr(agent.server, "telemetry"),
    "docker": getattr(getattr(agent.server, "docker_host", None), "status", None),
    "tcp_ok": measurements.filter(target__protocol="tcp", success=True).count(),
    "icmp": list(measurements.filter(target__protocol="icmp").values_list("success", "failure_reason")[:1]),
}))
')
    if python3 -c 'import json, sys; s = json.loads(sys.argv[1]); sys.exit(0 if s["seen"] and s["telemetry"] and s["tcp_ok"] and s["icmp"] else 1)' "$status"; then
        break
    fi
    sleep 1
done
echo "server view: $status"
python3 - "$status" <<'PY' || fail "agent data did not arrive as expected"
import json, sys
s = json.loads(sys.argv[1])
assert s["seen"], "no heartbeat recorded"
assert s["telemetry"], "no host telemetry (psutil under the sandbox?)"
assert s["docker"] == "unavailable", s["docker"]  # Docker SDK not installed
assert s["tcp_ok"] >= 1, "no successful TCP measurement"
assert s["icmp"] and s["icmp"][0][0] is True, f"ICMP under the sandbox: {s['icmp']}"
PY

echo "--- queue, logs and shutdown"
[ "$(stat -c '%a %U' /var/lib/ssphere-sentinel-agent)" = "700 sentinel-agent" ] || fail "state directory permissions"
[ "$(stat -c '%a %U' /var/lib/ssphere-sentinel-agent/network-queue.sqlite3)" = "600 sentinel-agent" ] || fail "queue file permissions"
systemctl stop sentinel-agent
[ "$(systemctl show -p Result --value sentinel-agent)" = "success" ] || fail "unclean stop"
journal=$(journalctl -u sentinel-agent --no-pager -o cat)
echo "$journal" | tail -n 8
grep -q "SSphere Sentinel agent .* starting" <<<"$journal" || fail "no startup log"
grep -q "Agent stopped" <<<"$journal" || fail "no shutdown log"
if grep -qF "$TOKEN" <<<"$journal"; then fail "token found in the journal"; fi
echo "agent systemd deployment passed"
