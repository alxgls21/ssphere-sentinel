/**
 * The installation of the agent on a Linux host with systemd, as docs/agent-deployment.md
 * describes it, filled with the server's address: what an operator copies next to the token.
 * The token itself is never part of it: step 3 reads it hidden from the terminal into the
 * root-only environment file, through a shell builtin and a pipe, so it is never an argument of
 * any command and never in a shell history or a process list. A rotated token has its own, shorter
 * commands: they replace the token line of that file and restart the agent, nothing else.
 */

export const AGENT_ENV_FILE = '/etc/ssphere-sentinel-agent/agent.env'
export const RELEASE_PLACEHOLDER = '<tag>'
const REPOSITORY = 'https://github.com/alxgls21/ssphere-sentinel'
const RAW = 'https://raw.githubusercontent.com/alxgls21/ssphere-sentinel'

/** `value` as one shell word, whatever it holds. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export function installCommands(serverUrl: string): string {
  const url = shellQuote(serverUrl)
  return [
    `# SSphere Sentinel agent on a Linux host with systemd (bash). Replace ${RELEASE_PLACEHOLDER} with the`,
    '# release you deploy, for example v0.2.0. Full guide: docs/agent-deployment.md in the repository.',
    '# Needs Python 3.11 or newer with venv, git and curl (step 1 installs them on Debian/Ubuntu);',
    '# ping, and step 4 of the guide, for ICMP targets.',
    '# Run step 3 on its own, or paste one step at a time: it asks for the token, and a paste of',
    '# the whole block depends on the shell having bracketed paste (bash 5.1 or newer).',
    '',
    '# 1. Prerequisites (Debian/Ubuntu), service account and virtual environment (safe to run again)',
    'sudo apt install -y python3-venv git curl',
    'id -u sentinel-agent > /dev/null 2>&1 || sudo useradd --system \\',
    '    --home-dir /var/lib/ssphere-sentinel-agent --no-create-home \\',
    '    --shell /usr/sbin/nologin sentinel-agent',
    'sudo python3 -m venv /opt/ssphere-sentinel-agent/venv',
    'sudo /opt/ssphere-sentinel-agent/venv/bin/pip install \\',
    `    "ssphere-sentinel-agent @ git+${REPOSITORY}@${RELEASE_PLACEHOLDER}#subdirectory=agent"`,
    '',
    '# 2. Deployment files of the same release',
    'for file in sentinel-agent.service enable-unprivileged-icmp.sh docker-monitoring.conf; do',
    `    curl -fsSLO "${RAW}/${RELEASE_PLACEHOLDER}/deploy/systemd/$file"`,
    'done',
    '',
    '# 3. Configuration: the token is typed hidden into the root-only environment file,',
    '#    never on a command line (an existing agent.env of this host is replaced).',
    'sudo install -d -m 0755 /etc/ssphere-sentinel-agent',
    `sudo install -m 0600 -o root -g root /dev/null ${AGENT_ENV_FILE}`,
    "read -rsp 'Paste the agent token, then press Enter: ' SENTINEL_AGENT_TOKEN && echo",
    `printf 'SENTINEL_URL=%s\\nSENTINEL_AGENT_TOKEN=%s\\n' ${url} "$SENTINEL_AGENT_TOKEN" \\`,
    `    | sudo tee ${AGENT_ENV_FILE} > /dev/null`,
    'unset SENTINEL_AGENT_TOKEN',
    '',
    '# 4. Start, and check (a healthy start logs two lines, then stays quiet)',
    'sudo install -m 0644 sentinel-agent.service /etc/systemd/system/sentinel-agent.service',
    'sudo systemctl daemon-reload',
    'sudo systemctl enable --now sentinel-agent',
    'systemctl status sentinel-agent',
  ].join('\n')
}

/**
 * A rotated token on a host that has the agent installed: the token line of the root-only
 * environment file is replaced (every other setting of the host is kept) and the service is
 * restarted, since a running agent would keep the old, dead token. The token is read hidden, as in
 * step 3 of the installation; the server's address is not needed, the file has it.
 */
export function rotationCommands(): string {
  return [
    '# SSphere Sentinel agent: the new token on a host that has the agent installed (bash).',
    `# Replaces the SENTINEL_AGENT_TOKEN line of ${AGENT_ENV_FILE}, keeps every other`,
    '# setting of the file, and restarts the agent. Run on its own: it asks for the token.',
    "read -rsp 'Paste the new agent token, then press Enter: ' SENTINEL_AGENT_TOKEN && echo",
    `sudo sed -i '/^SENTINEL_AGENT_TOKEN=/d' ${AGENT_ENV_FILE}`,
    `printf 'SENTINEL_AGENT_TOKEN=%s\\n' "$SENTINEL_AGENT_TOKEN" | sudo tee -a ${AGENT_ENV_FILE} > /dev/null`,
    'unset SENTINEL_AGENT_TOKEN',
    'sudo systemctl restart sentinel-agent',
    'systemctl status sentinel-agent',
  ].join('\n')
}
