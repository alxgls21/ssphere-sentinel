import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES } from '@/api/auth'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createMockApi } from '@/api/mock/client'
import type { AgentEnrollment, ScopeOptions, ServerDetail } from '@/api/types'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import AddServerPage from './AddServerPage'

const NOW = Date.parse('2026-10-12T14:00:00Z')
const TOKEN = 'Zm9yLXRlc3RzLW9ubHktbm90LWEtcmVhbC10b2tlbg'
const SCOPE: ScopeOptions = {
  customers: [{ id: 'c1', name: 'Meridian' }],
  sites: [{ id: 's1', customerId: 'c1', name: 'Athens DC' }],
}
const MAY_ADD = createFakeAuth({ capabilities: { ...NO_CAPABILITIES, manageServers: true } })

const shell = createFakeShell()
beforeEach(() => {
  vi.mocked(shell.announce).mockClear()
  vi.mocked(shell.flashStatus).mockClear()
})

function Where() {
  const { pathname, search, state } = useLocation()
  return (
    <>
      <span data-testid="where">{pathname + search}</span>
      <span data-testid="state">{JSON.stringify(state ?? null)}</span>
    </>
  )
}

/** The browser's Back: the page that showed the token is replaced in the history, so this lands elsewhere. */
function Back() {
  const navigate = useNavigate()
  return (
    <button type="button" data-testid="back" onClick={() => void navigate(-1)}>
      back
    </button>
  )
}

async function createdDetail(name: string): Promise<ServerDetail> {
  const real = createMockApi({ now: () => NOW, delayMs: 0 })
  const detail = await real.getServer('srv-ath-db-01')
  return {
    ...detail,
    agent: null,
    item: { ...detail.item, server: { ...detail.item.server, id: 'srv-new', name } },
  }
}

const enrollment = (): AgentEnrollment => ({
  generatedAt: new Date(NOW).toISOString(),
  item: {
    id: 'agent-new',
    name: 'web-9',
    enabled: true,
    lastSeenAt: null,
    agentVersion: '',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  },
  token: TOKEN,
  serverUrl: 'https://sentinel.example.net',
})

function setup({
  auth = MAY_ADD,
  createServer = vi.fn<SentinelApi['createServer']>(async (input) => createdDetail(input.name)),
  createAgent = vi.fn<SentinelApi['createAgent']>(async () => enrollment()),
  route = '/servers/new',
} = {}) {
  const getScopeOptions = vi.fn<SentinelApi['getScopeOptions']>(async () => SCOPE)
  const api = createTestApi({ source: 'http', getScopeOptions, createServer, createAgent })
  renderApp(
    <>
      <Routes>
        <Route path="/servers" element={<p>the list</p>} />
        <Route path="/servers/new" element={<AddServerPage />} />
        <Route path="/servers/:id" element={<p>server page</p>} />
      </Routes>
      <Where />
      <Back />
    </>,
    { api, route, withShell: shell, auth },
  )
  return { getScopeOptions, createServer, createAgent }
}

const where = () => screen.getByTestId('where').textContent
const state = (): unknown => JSON.parse(screen.getByTestId('state').textContent ?? 'null')
const field = (label: string) => screen.getByLabelText(label)
const submit = () => screen.getByRole('button', { name: 'Add server' })

describe('who may open it', () => {
  it('says so, and asks the server for nothing, without the capability', () => {
    const { getScopeOptions } = setup({ auth: createFakeAuth() })
    expect(screen.getByText('Not permitted to add servers')).toBeInTheDocument()
    expect(getScopeOptions).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })
})

describe('the form', () => {
  it('offers the name, the hostname, the sites by customer and the rest, with the name required', async () => {
    setup()
    expect(await screen.findByLabelText('Name')).toBeRequired()
    expect(field('Hostname')).not.toBeRequired()
    expect(
      within(field('Site'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No site (seen by accounts with every customer only)', 'Meridian / Athens DC'])
    expect(field('IP address')).toBeInTheDocument()
    expect(field('Operating system')).toBeInTheDocument()
    expect(field('Description')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Servers' })).toHaveAttribute('href', '/servers')
  })

  it('refuses an empty name here, says so under the field and on top, and asks the server for nothing', async () => {
    const user = userEvent.setup()
    const { createServer } = setup()
    await screen.findByLabelText('Name')
    await user.click(submit())
    expect(screen.getByRole('alert')).toHaveTextContent('Some values are not valid: name')
    expect(field('Name')).toHaveAccessibleDescription(/Error:\s*Required\./)
    expect(field('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(createServer).not.toHaveBeenCalled()
    expect(shell.announce).toHaveBeenCalledWith('Some values are not valid.')
    await user.type(field('Name'), 'w')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refuses a host name in the address field before asking the server', async () => {
    const user = userEvent.setup()
    const { createServer } = setup()
    await user.type(await screen.findByLabelText('Name'), 'web-9')
    await user.type(field('IP address'), 'web.example.com')
    await user.click(submit())
    expect(field('IP address')).toHaveAccessibleDescription(/Expected an IPv4 or IPv6 address/)
    expect(createServer).not.toHaveBeenCalled()
  })

  it('sends what was typed, trimmed, with the site chosen and nothing it did not mean to', async () => {
    const user = userEvent.setup()
    const { createServer } = setup()
    await user.type(await screen.findByLabelText('Name'), ' web-9 ')
    await user.type(field('Hostname'), 'web-9.example.net')
    await user.selectOptions(field('Site'), 's1')
    await user.type(field('IP address'), '10.0.0.9')
    await user.type(field('Operating system'), 'Debian 12')
    await user.click(submit())
    await waitFor(() =>
      expect(createServer).toHaveBeenCalledWith({
        name: 'web-9',
        hostname: 'web-9.example.net',
        operatingSystem: 'Debian 12',
        ipAddress: '10.0.0.9',
        siteId: 's1',
      }),
    )
  })
})

describe('the server’s answer', () => {
  it('puts each field problem under its field, and a taken name under the name', async () => {
    const user = userEvent.setup()
    const createServer = vi
      .fn<SentinelApi['createServer']>()
      .mockRejectedValueOnce(
        new ApiError('Some values are not valid.', 400, 'validation_error', {
          fields: { siteId: ['No such site.'], ipAddress: ['Expected an IPv4 or IPv6 address.'] },
        }),
      )
      .mockRejectedValueOnce(
        new ApiError('A server with this name already exists.', 409, 'server_exists'),
      )
    setup({ createServer })
    await user.type(await screen.findByLabelText('Name'), 'web-9')
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('siteId, ipAddress')
    expect(field('Site')).toHaveAccessibleDescription(/No such site\./)
    expect(field('IP address')).toHaveAccessibleDescription(/Expected an IPv4 or IPv6 address\./)
    expect(shell.announce).toHaveBeenCalledWith('The server was not created.')

    await user.type(field('Name'), '2')
    await user.click(submit())
    await waitFor(() =>
      expect(field('Name')).toHaveAccessibleDescription(/A server with this name already exists\./),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Some values are not valid: name')
    expect(screen.queryByText('server page')).toBeNull()
  })

  it('says it was refused, and that nothing is known to have changed when there was no answer', async () => {
    const user = userEvent.setup()
    const createServer = vi
      .fn<SentinelApi['createServer']>()
      .mockRejectedValueOnce(new ApiError('Forbidden.', 403, 'forbidden'))
      .mockRejectedValueOnce(new ApiError('Cannot reach the server.', null, 'network'))
    setup({ createServer })
    await user.type(await screen.findByLabelText('Name'), 'web-9')
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account may not make this change.',
    )
    await user.click(submit())
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The server could not be reached. Nothing is known to have changed',
      ),
    )
  })

  it('offers to create the agent again when the server was created but its agent was not', async () => {
    const user = userEvent.setup()
    const createAgent = vi
      .fn<SentinelApi['createAgent']>()
      .mockRejectedValueOnce(new ApiError('Cannot reach the server.', null, 'network'))
      .mockResolvedValueOnce(enrollment())
    const { createServer } = setup({ createAgent })
    await user.type(await screen.findByLabelText('Name'), 'web-9')
    await user.click(submit())
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent('The server “web-9” is created, but its agent is not.')
    expect(within(notice).getByRole('link', { name: 'the server’s page' })).toHaveAttribute(
      'href',
      '/servers/srv-new',
    )
    expect(screen.queryByLabelText('Name')).toBeNull()
    await user.click(within(notice).getByRole('button', { name: 'Create the agent' }))
    expect(await screen.findByLabelText('Agent token')).toHaveTextContent(TOKEN)
    expect(createServer).toHaveBeenCalledTimes(1)
    expect(createAgent).toHaveBeenCalledTimes(2)
    expect(createAgent).toHaveBeenLastCalledWith('srv-new', {})
  })

  it('goes to the server’s page when the agent exists already, saying its token was not shown', async () => {
    const user = userEvent.setup()
    // The first answer was lost (the agent may well exist); the retry says so: no token can be shown here.
    const createAgent = vi
      .fn<SentinelApi['createAgent']>()
      .mockRejectedValueOnce(new ApiError('The server did not answer in time.', null, 'timeout'))
      .mockRejectedValueOnce(new ApiError('This server already has an agent.', 409, 'agent_exists'))
    setup({ createAgent })
    await user.type(await screen.findByLabelText('Name'), 'web-9')
    await user.click(submit())
    const notice = await screen.findByRole('alert')
    await user.click(within(notice).getByRole('button', { name: 'Create the agent' }))
    expect(await screen.findByText('server page')).toBeInTheDocument()
    expect(where()).toBe('/servers/srv-new')
    expect(state()).toEqual({ agentTokenNotShown: true })
    expect(shell.announce).toHaveBeenLastCalledWith(
      'The agent exists already, but its token was not shown: rotate it from the server’s page.',
    )
    expect(document.body.textContent).not.toContain('This server already has an agent.')
    expect(createAgent).toHaveBeenCalledTimes(2)
  })
})

describe('the token, shown once', () => {
  async function added(user: ReturnType<typeof userEvent.setup>) {
    const served = setup()
    await user.type(await screen.findByLabelText('Name'), 'web-9')
    await user.click(submit())
    await screen.findByLabelText('Agent token')
    return served
  }

  it('shows the token and the server address once the server and its agent exist, with the warning', async () => {
    const user = userEvent.setup()
    const { createAgent } = await added(user)
    expect(createAgent).toHaveBeenCalledWith('srv-new', {})
    expect(screen.getByLabelText('Agent token')).toHaveTextContent(TOKEN)
    expect(screen.getByLabelText('Server URL')).toHaveTextContent('https://sentinel.example.net')
    expect(screen.getByRole('status')).toHaveTextContent('shown once')
    expect(screen.getByRole('status')).toHaveTextContent('cannot show it again')
    expect(shell.announce).toHaveBeenCalledWith(
      'Server and agent created. The agent token is shown once.',
    )
    // The form is gone: the server exists, and the token is the one thing left to do.
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(where()).toBe('/servers/new')
  })

  it('moves the focus to the notice that the token is shown once', async () => {
    const user = userEvent.setup()
    await added(user)
    // The pressed button is gone with the form: the notice takes the focus, so it is read next.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(document.activeElement?.contains(screen.getByRole('status'))).toBe(true)
    expect(document.activeElement).toHaveTextContent('Its token is shown once')
  })

  it('gives installation commands with the address filled in and the token kept off every command line', async () => {
    const user = userEvent.setup()
    await added(user)
    const commands = screen.getByLabelText('Installation commands')
    expect(commands).toHaveTextContent("'https://sentinel.example.net'")
    expect(commands).toHaveTextContent('read -rsp')
    expect(commands).toHaveTextContent('systemctl enable --now sentinel-agent')
    expect(commands.textContent).not.toContain(TOKEN)
  })

  it('shows the token but no commands without the server’s address, and says to set SENTINEL_URL', async () => {
    const user = userEvent.setup()
    setup({
      createAgent: vi.fn<SentinelApi['createAgent']>(async () => ({
        ...enrollment(),
        serverUrl: null,
      })),
    })
    await user.type(await screen.findByLabelText('Name'), 'web-9')
    await user.click(submit())
    expect(await screen.findByLabelText('Agent token')).toHaveTextContent(TOKEN)
    expect(screen.queryByLabelText('Installation commands')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy commands' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull()
    expect(screen.queryByLabelText('Server URL')).toBeNull()
    expect(screen.getAllByText(/set SENTINEL_URL on the server/).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('http://')
  })

  it('copies the token, the address and the commands, and says so', async () => {
    const user = userEvent.setup()
    await added(user)
    await user.click(screen.getByRole('button', { name: 'Copy token' }))
    expect(await navigator.clipboard.readText()).toBe(TOKEN)
    await waitFor(() => expect(shell.flashStatus).toHaveBeenCalledWith('Token copied'))
    expect(screen.getByRole('button', { name: 'Token copied' })).toHaveTextContent('Copied')
    await user.click(screen.getByRole('button', { name: 'Copy URL' }))
    expect(await navigator.clipboard.readText()).toBe('https://sentinel.example.net')
    await user.click(screen.getByRole('button', { name: 'Copy commands' }))
    expect(await navigator.clipboard.readText()).toContain('sudo systemctl enable --now')
  })

  it('says so when the copy did not work', async () => {
    const user = userEvent.setup()
    await added(user)
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
    await user.click(screen.getByRole('button', { name: 'Copy token' }))
    await waitFor(() =>
      expect(shell.flashStatus).toHaveBeenCalledWith(
        'Could not copy: select the token and copy it',
      ),
    )
    expect(screen.getByRole('button', { name: 'Copy token' })).toBeInTheDocument()
    Reflect.deleteProperty(document, 'execCommand')
  })

  it('forgets the token on Done: the server’s page replaces this one, and Back does not return to it', async () => {
    const user = userEvent.setup()
    await added(user)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('server page')).toBeInTheDocument()
    expect(where()).toBe('/servers/srv-new')
    expect(document.body.textContent).not.toContain(TOKEN)
    await user.click(screen.getByTestId('back'))
    await waitFor(() => expect(where()).not.toBe('/servers/new'))
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('keeps the token out of the address, the history state and the browser storage', async () => {
    const user = userEvent.setup()
    await added(user)
    expect(where()).not.toContain(TOKEN)
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(TOKEN)
    expect(JSON.stringify(localStorage)).not.toContain(TOKEN)
    expect(JSON.stringify(sessionStorage)).not.toContain(TOKEN)
  })
})
