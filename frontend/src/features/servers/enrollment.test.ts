import { describe, expect, it } from 'vitest'
import { AGENT_ENV_FILE, installCommands, rotationCommands, shellQuote } from './enrollment'

const TOKEN = 'Zm9yLXRlc3RzLW9ubHktbm90LWEtcmVhbC10b2tlbg'

describe('installCommands', () => {
  const script = installCommands('https://sentinel.example.net')
  const lines = script.split('\n')

  it('fills in the server address as one shell word, and never a token', () => {
    expect(script).toContain("'https://sentinel.example.net'")
    expect(script).not.toContain(TOKEN)
    expect(installCommands("https://it's.example")).toContain(`'https://it'\\''s.example'`)
  })

  it('keeps the token off every command line: read hidden, written through a builtin and a pipe, forgotten', () => {
    const mentions = lines.filter((line) => line.includes('SENTINEL_AGENT_TOKEN'))
    expect(mentions).toEqual([
      "read -rsp 'Paste the agent token, then press Enter: ' SENTINEL_AGENT_TOKEN && echo",
      `printf 'SENTINEL_URL=%s\\nSENTINEL_AGENT_TOKEN=%s\\n' 'https://sentinel.example.net' "$SENTINEL_AGENT_TOKEN" \\`,
      'unset SENTINEL_AGENT_TOKEN',
    ])
    // The value is only ever an argument of the printf builtin, never of sudo, tee or anything executed.
    const uses = lines.filter((candidate) => candidate.includes('"$SENTINEL_AGENT_TOKEN"'))
    expect(uses).toHaveLength(1)
    for (const use of uses) {
      expect(use.startsWith('printf ')).toBe(true)
    }
  })

  it('creates the environment file root-only before anything is written into it', () => {
    const create = lines.findIndex((line) =>
      line.includes(`install -m 0600 -o root -g root /dev/null ${AGENT_ENV_FILE}`),
    )
    const write = lines.findIndex((line) => line.includes(`sudo tee ${AGENT_ENV_FILE} > /dev/null`))
    expect(create).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(create)
  })

  it('follows the deployment guide: service account, venv, unit, enable --now', () => {
    expect(script).toContain('useradd --system')
    expect(script).toContain('python3 -m venv /opt/ssphere-sentinel-agent/venv')
    expect(script).toContain('#subdirectory=agent')
    expect(script).toContain('sudo systemctl enable --now sentinel-agent')
    expect(script).toContain('<tag>')
  })

  it('names the prerequisites, installs them on Debian/Ubuntu, and says to run step 3 on its own', () => {
    expect(lines).toContain('sudo apt install -y python3-venv git curl')
    expect(script).toContain('git and curl')
    expect(script).toMatch(/Run step 3 on its own, or paste one step at a time/)
  })
})

describe('rotationCommands', () => {
  const script = rotationCommands()
  const lines = script.split('\n')

  it('replaces the token line only, restarts the agent, and keeps the token off every command line', () => {
    expect(lines.filter((line) => !line.startsWith('#'))).toEqual([
      "read -rsp 'Paste the new agent token, then press Enter: ' SENTINEL_AGENT_TOKEN && echo",
      `sudo sed -i '/^SENTINEL_AGENT_TOKEN=/d' ${AGENT_ENV_FILE}`,
      `printf 'SENTINEL_AGENT_TOKEN=%s\\n' "$SENTINEL_AGENT_TOKEN" | sudo tee -a ${AGENT_ENV_FILE} > /dev/null`,
      'unset SENTINEL_AGENT_TOKEN',
      'sudo systemctl restart sentinel-agent',
      'systemctl status sentinel-agent',
    ])
    expect(script).toMatch(/^# .*restart/m)
  })

  it('is not an installation: no new file, no venv, no unit, no address; the rest of agent.env is kept', () => {
    expect(script).not.toContain(`/dev/null ${AGENT_ENV_FILE}`)
    expect(script).not.toContain(`sudo tee ${AGENT_ENV_FILE}`)
    expect(script).not.toContain('venv')
    expect(script).not.toContain('useradd')
    expect(script).not.toContain('enable --now')
    expect(script).not.toContain('SENTINEL_URL')
  })
})

describe('shellQuote', () => {
  it('quotes anything as one word', () => {
    expect(shellQuote('plain')).toBe("'plain'")
    expect(shellQuote('a b $HOME `x`')).toBe("'a b $HOME `x`'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})
