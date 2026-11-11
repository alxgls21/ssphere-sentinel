import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { InitialEntry } from 'react-router'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { NO_CAPABILITIES } from '@/api/auth'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createMockApi } from '@/api/mock/client'
import type { AgentEnrollment, MonitoringAgent, ServerDetail } from '@/api/types'
import type { Resource } from '@/hooks/useResource'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import { AgentPanel } from './AgentPanel'

const NOW = Date.parse('2026-10-12T14:00:00Z')
const TOKEN = 'bmV3LXRva2VuLWZvci10ZXN0cy1vbmx5'
const MAY = createFakeAuth({ capabilities: { ...NO_CAPABILITIES, manageServers: true } })

const shell = createFakeShell()
beforeEach(() => vi.mocked(shell.announce).mockClear())

const agent = (over: Partial<MonitoringAgent> = {}): MonitoringAgent => ({
  id: 'agent-1',
  name: 'ath-db-01',
  enabled: true,
  lastSeenAt: new Date(NOW - 20_000).toISOString(),
  agentVersion: '0.4.2',
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  updatedAt: new Date(NOW - 20_000).toISOString(),
  ...over,
})

async function detailWith(found: MonitoringAgent | null): Promise<ServerDetail> {
  const real = createMockApi({ now: () => NOW, delayMs: 0 })
  return { ...(await real.getServer('srv-ath-db-01')), agent: found }
}

const enrollment = (): AgentEnrollment => ({
  generatedAt: new Date(NOW).toISOString(),
  item: agent(),
  token: TOKEN,
  serverUrl: 'https://sentinel.example.net',
})

function resourceOf(detail: ServerDetail): Resource<ServerDetail> & { refetch: Mock<() => void> } {
  return {
    status: 'success',
    data: detail,
    error: null,
    isRefreshing: false,
    updatedAt: NOW,
    refetch: vi.fn<() => void>(),
  }
}

async function setup(
  found: MonitoringAgent | null,
  {
    auth = MAY,
    rotateAgentToken = vi.fn<SentinelApi['rotateAgentToken']>(async () => enrollment()),
    setAgentEnabled = vi.fn<SentinelApi['setAgentEnabled']>(async (_id, enabled) => ({
      generatedAt: new Date(NOW).toISOString(),
      item: agent({ enabled }),
    })),
    createAgent = vi.fn<SentinelApi['createAgent']>(async () => enrollment()),
    route = '/' as InitialEntry,
  } = {},
) {
  const resource = resourceOf(await detailWith(found))
  const api = createTestApi({ source: 'http', rotateAgentToken, setAgentEnabled, createAgent })
  renderApp(
    <AgentPanel index={2} serverId="srv-ath-db-01" serverName="ath-db-01" resource={resource} />,
    { api, withShell: shell, auth, route },
  )
  return { resource, rotateAgentToken, setAgentEnabled, createAgent }
}

const panel = () => screen.getByRole('region', { name: 'Agent' })

/** Rotate token, confirmed: the panel then shows the new token. */
async function rotated(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(panel()).getByRole('button', { name: 'Rotate token' }))
  await user.click(
    within(within(panel()).getByRole('alertdialog')).getByRole('button', { name: 'Rotate token' }),
  )
  await within(panel()).findByLabelText('Agent token')
}

describe('AgentPanel', () => {
  it('says who reports for the server: name, state, last heartbeat and version', async () => {
    await setup(agent())
    expect(panel()).toHaveTextContent('ath-db-01')
    expect(within(panel()).getByText('ENABLED')).toBeInTheDocument()
    expect(panel()).toHaveTextContent('20s ago')
    expect(panel()).toHaveTextContent('v0.4.2')
  })

  it('offers no action to an account that may not manage hosts', async () => {
    await setup(agent(), { auth: createFakeAuth() })
    expect(within(panel()).queryByRole('button')).toBeNull()
    expect(panel()).toHaveTextContent('ENABLED')
  })

  it('says a server has no agent, and offers to create one only to an account that may', async () => {
    await setup(null, { auth: createFakeAuth() })
    expect(panel()).toHaveTextContent('This server has no agent yet')
    expect(within(panel()).queryByRole('button', { name: 'Create agent' })).toBeNull()
  })

  it('creates the agent and shows its token once', async () => {
    const user = userEvent.setup()
    const { createAgent, resource } = await setup(null)
    await user.click(within(panel()).getByRole('button', { name: 'Create agent' }))
    expect(await within(panel()).findByLabelText('Agent token')).toHaveTextContent(TOKEN)
    expect(createAgent).toHaveBeenCalledWith('srv-ath-db-01', {})
    expect(shell.announce).toHaveBeenCalledWith('Agent created. Its token is shown once.')
    await user.click(within(panel()).getByRole('button', { name: 'Done' }))
    expect(within(panel()).queryByLabelText('Agent token')).toBeNull()
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(resource.refetch).toHaveBeenCalled()
  })

  describe('rotating the token', () => {
    it('asks first, with Cancel focused, and does nothing on Cancel or Escape', async () => {
      const user = userEvent.setup()
      const { rotateAgentToken } = await setup(agent())
      await user.click(within(panel()).getByRole('button', { name: 'Rotate token' }))
      const dialog = within(panel()).getByRole('alertdialog')
      expect(dialog).toHaveAccessibleName(/Give the agent of “ath-db-01” a new token\?/)
      expect(dialog).toHaveTextContent('The current token stops working at once')
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(within(panel()).queryByRole('alertdialog')).toBeNull()
      expect(rotateAgentToken).not.toHaveBeenCalled()
      await user.click(within(panel()).getByRole('button', { name: 'Rotate token' }))
      await user.click(within(panel()).getByRole('button', { name: 'Cancel' }))
      expect(within(panel()).queryByRole('alertdialog')).toBeNull()
      expect(rotateAgentToken).not.toHaveBeenCalled()
    })

    it('rotates on confirmation and shows the new token once, then forgets it on Done', async () => {
      const user = userEvent.setup()
      const { rotateAgentToken, resource } = await setup(agent())
      await user.click(within(panel()).getByRole('button', { name: 'Rotate token' }))
      await user.click(
        within(within(panel()).getByRole('alertdialog')).getByRole('button', {
          name: 'Rotate token',
        }),
      )
      expect(await within(panel()).findByLabelText('Agent token')).toHaveTextContent(TOKEN)
      expect(rotateAgentToken).toHaveBeenCalledWith('agent-1')
      expect(within(panel()).getByRole('status')).toHaveTextContent(
        'The previous token stopped working at once',
      )
      expect(shell.announce).toHaveBeenCalledWith('Token rotated. The new token is shown once.')
      await user.click(within(panel()).getByRole('button', { name: 'Done' }))
      expect(document.body.textContent).not.toContain(TOKEN)
      expect(resource.refetch).toHaveBeenCalled()
    })

    it('shows the commands that replace the token line and restart the agent, not an installation', async () => {
      const user = userEvent.setup()
      await setup(agent())
      await rotated(user)
      expect(within(panel()).getByRole('status')).toHaveTextContent('restarted')
      const commands = within(panel()).getByLabelText('Rotation commands')
      expect(commands).toHaveTextContent(
        "sudo sed -i '/^SENTINEL_AGENT_TOKEN=/d' /etc/ssphere-sentinel-agent/agent.env",
      )
      expect(commands).toHaveTextContent('| sudo tee -a /etc/ssphere-sentinel-agent/agent.env')
      expect(commands).toHaveTextContent('sudo systemctl restart sentinel-agent')
      expect(commands.textContent).not.toContain(TOKEN)
      expect(commands.textContent).not.toContain('/dev/null /etc/ssphere-sentinel-agent/agent.env')
      expect(commands.textContent).not.toContain('enable --now')
      expect(commands.textContent).not.toContain('useradd')
      expect(within(panel()).queryByLabelText('Installation commands')).toBeNull()
      await user.click(within(panel()).getByRole('button', { name: 'Copy commands' }))
      expect(await navigator.clipboard.readText()).toContain(
        'sudo systemctl restart sentinel-agent',
      )
    })

    it('moves the focus to the notice that the token is shown once', async () => {
      const user = userEvent.setup()
      await setup(agent())
      await rotated(user)
      // The confirmed button is gone: the notice takes the focus, so it is read next.
      await waitFor(() => expect(document.activeElement).not.toBe(document.body))
      expect(document.activeElement?.contains(within(panel()).getByRole('status'))).toBe(true)
    })

    it('says, when sent here because the agent existed already, that no token was shown, until one is rotated', async () => {
      const user = userEvent.setup()
      await setup(agent(), { route: { pathname: '/', state: { agentTokenNotShown: true } } })
      const notice = within(panel()).getByRole('status')
      expect(notice).toHaveTextContent('no token was shown')
      expect(notice).toHaveTextContent('rotate')
      await rotated(user)
      await user.click(within(panel()).getByRole('button', { name: 'Done' }))
      expect(within(panel()).queryByText(/no token was shown/)).toBeNull()
    })

    it('says so when the server refused, and keeps the agent as it was', async () => {
      const user = userEvent.setup()
      await setup(agent(), {
        rotateAgentToken: vi
          .fn<SentinelApi['rotateAgentToken']>()
          .mockRejectedValue(new ApiError('Not found.', 404, 'not_found')),
      })
      await user.click(within(panel()).getByRole('button', { name: 'Rotate token' }))
      await user.click(
        within(within(panel()).getByRole('alertdialog')).getByRole('button', {
          name: 'Rotate token',
        }),
      )
      expect(await within(panel()).findByRole('alert')).toHaveTextContent(
        'It no longer exists, or you may no longer see it.',
      )
      expect(within(panel()).queryByLabelText('Agent token')).toBeNull()
      expect(shell.announce).toHaveBeenCalledWith('The agent was not changed.')
    })
  })

  describe('disabling and enabling', () => {
    it('disables the agent, says what that means, and reads the server again', async () => {
      const user = userEvent.setup()
      const { setAgentEnabled, resource } = await setup(agent())
      await user.click(within(panel()).getByRole('button', { name: 'Disable agent' }))
      await waitFor(() => expect(setAgentEnabled).toHaveBeenCalledWith('agent-1', false))
      await waitFor(() => expect(resource.refetch).toHaveBeenCalled())
      expect(shell.announce).toHaveBeenCalledWith('Agent disabled.')
    })

    it('offers to enable a disabled agent, and says its heartbeats are refused meanwhile', async () => {
      const user = userEvent.setup()
      const { setAgentEnabled } = await setup(agent({ enabled: false }))
      expect(within(panel()).getByText('DISABLED')).toBeInTheDocument()
      expect(panel()).toHaveTextContent('its heartbeats are refused')
      await user.click(within(panel()).getByRole('button', { name: 'Enable agent' }))
      await waitFor(() => expect(setAgentEnabled).toHaveBeenCalledWith('agent-1', true))
      expect(shell.announce).toHaveBeenCalledWith('Agent enabled.')
    })

    it('shows the refusal in the panel when the change failed', async () => {
      const user = userEvent.setup()
      await setup(agent(), {
        setAgentEnabled: vi
          .fn<SentinelApi['setAgentEnabled']>()
          .mockRejectedValue(new ApiError('Forbidden.', 403, 'forbidden')),
      })
      await user.click(within(panel()).getByRole('button', { name: 'Disable agent' }))
      expect(await within(panel()).findByRole('alert')).toHaveTextContent(
        'This account may not make this change.',
      )
    })
  })
})
