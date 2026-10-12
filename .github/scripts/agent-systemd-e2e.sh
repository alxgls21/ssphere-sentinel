#!/usr/bin/env bash
# End-to-end test of the documented agent deployment (docs/agent-deployment.md):
# install the agent into /opt with the system Python, enable unprivileged ICMP
# for its group with the shipped helper, run it under the shipped hardened
# systemd unit against the Compose server, and verify that liveness, telemetry
# and ICMP/TCP measurements arrive while the agent holds no capabilities. Run
# as root on a disposable machine (CI runner) with the Compose stack up.
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
registration=$(manage shell -c '
from apps.agents.services import create_agent
from apps.infrastructure.models import Server
from apps.network.models import NetworkTarget
server = Server.objects.create(name="ci-agent-host", hostname="ci.local")
agent, token = create_agent(server=server, name="ci-agent")
common = {"hostname_or_ip": "127.0.0.1", "monitoring_interval_seconds": 10, "assigned_agent": agent}
tcp = NetworkTarget.objects.create(name="web-tcp", protocol="tcp", port=8000, **common)
icmp = NetworkTarget.objects.create(name="loopback-icmp", protocol="icmp", **common)
print(token, tcp.pk, icmp.pk)
') || fail "could not register the agent on the server"
read -r TOKEN TCP_ID ICMP_ID <<<"$registration"
# Never print $registration: it contains the agent token.
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if [ -z "${TOKEN:-}" ] || ! [[ ${TCP_ID:-} =~ $uuid && ${ICMP_ID:-} =~ $uuid ]]; then
    fail "unexpected output while registering the agent on the server"
fi
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

echo "--- ICMP under the hardened sandbox"
# The unit grants no capabilities, so ping cannot use its CAP_NET_RAW file
# capability and needs unprivileged ICMP sockets (net.ipv4.ping_group_range),
# which Debian and Ubuntu leave disabled. Prove both halves with ping running
# as a oneshot copy of the shipped unit: same account, identical sandbox.
ping_bin=$(command -v ping)
if command -v getcap >/dev/null; then
    echo "file capabilities: $(getcap "$ping_bin" || true)"
fi
echo "net.ipv4.ping_group_range before: $(cat /proc/sys/net/ipv4/ping_group_range)"
pingtest=sentinel-agent-pingtest.service
pingtest_log=/run/sentinel-agent-pingtest.log
sed -e 's|^Type=exec$|Type=oneshot|' \
    -e "s|^ExecStart=.*|ExecStart=${ping_bin} -c 1 -W 2 127.0.0.1|" \
    -e '/^Restart/d' \
    /etc/systemd/system/sentinel-agent.service > "/run/systemd/system/${pingtest}"
# ping's output goes to a file that systemd opens before starting it, so the
# checks below never depend on when journald has processed the lines. The C
# locale keeps ping's messages in English, and a start timeout turns a hang
# into a failed run. The sandbox is not changed.
mkdir -p "/run/systemd/system/${pingtest}.d"
cat > "/run/systemd/system/${pingtest}.d/capture-output.conf" <<UNIT
[Service]
Environment=LC_ALL=C
StandardOutput=truncate:${pingtest_log}
StandardError=inherit
TimeoutStartSec=30s
UNIT
systemctl daemon-reload

# Runs ping once in the test unit and records the outcome in ping_rc (exit
# status of "systemctl start"), ping_result (unit Result), ping_status (ping's
# exit status) and ping_output. A failed run is expected in the negative check,
# so it is recorded rather than fatal; every caller asserts on the outcome.
run_sandboxed_ping() {
    rm -f "$pingtest_log"
    systemctl reset-failed "$pingtest" 2>/dev/null || true
    ping_rc=0
    systemctl start "$pingtest" || ping_rc=$?
    ping_result=$(systemctl show -p Result --value "$pingtest")
    ping_status=$(systemctl show -p ExecMainStatus --value "$pingtest")
    if [ -f "$pingtest_log" ]; then
        ping_output=$(cat "$pingtest_log")
    else
        ping_output="(ping did not run: no output captured)"
    fi
    echo "sandboxed ping: systemctl start exit ${ping_rc}, unit result ${ping_result}, ping exit ${ping_status}"
    printf '%s\n' "$ping_output" | sed 's/^/    /'
}

# Fails the run for an unexpected ping-test outcome, after showing systemd's
# explanation (e.g. 226/NAMESPACE). Diagnostics only: never used to decide.
fail_pingtest() {
    systemctl status "$pingtest" --no-pager --lines=20 || true
    fail "$@"
}

agent_gid=$(getent group sentinel-agent | cut -d: -f3) || fail "the sentinel-agent group does not exist"
[ -n "$agent_gid" ] || fail "the sentinel-agent group has no gid"
read -r low high < /proc/sys/net/ipv4/ping_group_range
if [ "$low" -gt "$agent_gid" ] || [ "$agent_gid" -gt "$high" ]; then
    echo "unprivileged ICMP is disabled for gid ${agent_gid}: ping must be refused in the sandbox"
    run_sandboxed_ping
    if [ "$ping_rc" -eq 0 ]; then
        fail_pingtest "ping worked in the sandbox although unprivileged ICMP is disabled for gid ${agent_gid}"
    fi
    # The only acceptable failure: ping ran and exited 2 because the kernel
    # refused both ICMP socket types. Anything else (the unit could not start,
    # a sandbox setup error such as 226/NAMESPACE, a timeout) is a real failure.
    if [ "$ping_result" != "exit-code" ] || [ "$ping_status" != "2" ]; then
        fail_pingtest "sandboxed ping failed for an unexpected reason (unit result ${ping_result}, exit ${ping_status})"
    fi
    if ! grep -q "Operation not permitted" <<<"$ping_output"; then
        fail_pingtest "sandboxed ping did not report a permission error"
    fi
    echo "confirmed: no capability in the sandbox, so ICMP needs ping_group_range"
else
    echo "unprivileged ICMP already allowed for gid ${agent_gid}; negative check skipped"
fi

sh deploy/systemd/enable-unprivileged-icmp.sh || fail "ICMP helper failed"
second_run=$(sh deploy/systemd/enable-unprivileged-icmp.sh) || fail "ICMP helper failed on its second run"
grep -q "already allowed" <<<"$second_run" || fail "ICMP helper is not idempotent: ${second_run}"
echo "net.ipv4.ping_group_range after: $(cat /proc/sys/net/ipv4/ping_group_range)"
run_sandboxed_ping
if [ "$ping_rc" -ne 0 ] || [ "$ping_result" != "success" ] || [ "$ping_status" != "0" ]; then
    fail_pingtest "ping fails in the sandbox with unprivileged ICMP allowed for gid ${agent_gid} (unit result ${ping_result}, exit ${ping_status})"
fi
echo "confirmed: ICMP works for the agent group with no capabilities"
rm -r "/run/systemd/system/${pingtest}" "/run/systemd/system/${pingtest}.d" "$pingtest_log"
systemctl daemon-reload

systemctl enable --now sentinel-agent || fail "the agent service did not start"

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
') || fail "could not query the server for the agent's data"
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

echo "--- the agent runs unprivileged"
pid=$(systemctl show -p MainPID --value sentinel-agent)
[ "$pid" -gt 0 ] || fail "agent is not running"
proc_status=$(cat "/proc/${pid}/status") || fail "cannot read /proc/${pid}/status"
grep -E '^(Uid|Gid|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):' <<<"$proc_status" || true
agent_uid=$(id -u sentinel-agent)
[ "$agent_uid" -ne 0 ] || fail "the sentinel-agent account is root"
# Real, effective, saved and filesystem IDs must all be the service account.
for field in Uid Gid; do
    expected=$agent_uid
    [ "$field" = Gid ] && expected=$agent_gid
    ids=$(awk -v key="${field}:" '$1 == key {print $2, $3, $4, $5}' <<<"$proc_status")
    [ "$ids" = "${expected} ${expected} ${expected} ${expected}" ] \
        || fail "${field} is '${ids}', expected ${expected} for every field"
done
for set in CapInh CapPrm CapEff CapBnd CapAmb; do
    value=$(awk -v key="${set}:" '$1 == key {print $2}' <<<"$proc_status")
    [ "$value" = "0000000000000000" ] || fail "${set} is '${value}': the agent holds capabilities"
done
[ "$(awk '$1 == "NoNewPrivs:" {print $2}' <<<"$proc_status")" = "1" ] || fail "NoNewPrivs is not set"

echo "--- queue, logs and shutdown"
[ "$(stat -c '%a %U' /var/lib/ssphere-sentinel-agent)" = "700 sentinel-agent" ] || fail "state directory permissions"
[ "$(stat -c '%a %U' /var/lib/ssphere-sentinel-agent/network-queue.sqlite3)" = "600 sentinel-agent" ] || fail "queue file permissions"
systemctl stop sentinel-agent
[ "$(systemctl show -p Result --value sentinel-agent)" = "success" ] || fail "unclean stop"
journal=$(journalctl -u sentinel-agent --no-pager -o cat) || fail "cannot read the agent's journal"
echo "$journal" | tail -n 8
grep -q "SSphere Sentinel agent .* starting" <<<"$journal" || fail "no startup log"
grep -q "Agent stopped" <<<"$journal" || fail "no shutdown log"
if grep -qF "$TOKEN" <<<"$journal"; then fail "token found in the journal"; fi
echo "agent systemd deployment passed"
