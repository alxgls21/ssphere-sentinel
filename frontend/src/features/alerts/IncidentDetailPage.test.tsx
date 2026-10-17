import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { IncidentDetail, IncidentItem } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import IncidentDetailPage from './IncidentDetailPage'
import { detail, incident, iso, NOW, overview, engine } from './testing'

const overrides = registryOverrides()
afterEach(() => overrides.restore())

function Where() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

interface Served {
  detail?: IncidentDetail | Error
  ack?: SentinelApi['acknowledgeIncident']
}

function setup({ detail: shown = detail(), ack }: Served = {}) {
  const getIncident = vi.fn<SentinelApi['getIncident']>(async () => {
    if (shown instanceof Error) throw shown
    return shown
  })
  const acknowledgeIncident = vi.fn<SentinelApi['acknowledgeIncident']>(
    ack ??
      (async () =>
        detail(incident({ status: 'acknowledged', acknowledgedBy: 'ana' }), {
          generatedAt: new Date(NOW + 1000).toISOString(),
        })),
  )
  const getIncidentOverview = vi.fn<SentinelApi['getIncidentOverview']>(async () => overview())
  const getEngineStatus = vi.fn<SentinelApi['getEngineStatus']>(async () => engine())
  const api = createTestApi({
    getIncident,
    acknowledgeIncident,
    getIncidentOverview,
    getEngineStatus,
    source: 'http',
  })
  return { api, getIncident, acknowledgeIncident, getIncidentOverview }
}

const shell = createFakeShell()

function page(
  served: ReturnType<typeof setup> = setup(),
  route: string | { pathname: string; search?: string; state?: unknown } = '/alerts/inc-1',
) {
  renderApp(
    <>
      <Routes>
        <Route path="/alerts" element={<p>alerts list</p>} />
        <Route path="/alerts/:id" element={<IncidentDetailPage />} />
        <Route path="/servers/:id" element={<p>server page</p>} />
        <Route path="/snmp/:id" element={<p>device page</p>} />
        <Route path="/network/:id" element={<p>target page</p>} />
        <Route path="/docker" element={<p>docker page</p>} />
      </Routes>
      <Where />
    </>,
    {
      api: served.api,
      route,
      withAlerts: true,
      withShell: shell,
      auth: createFakeAuth({ user: { username: 'ana', displayName: 'Ana' } }),
    },
  )
  return served
}

const summary = () => screen.findByRole('region', { name: 'Summary' })
const fact = (panel: HTMLElement, label: string) =>
  within(panel).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement
const header = () =>
  screen.getByRole('heading', { level: 1 }).parentElement?.parentElement as HTMLElement

const open = (item: IncidentItem) => detail(item)

describe('the header', () => {
  it('names the object, its severity and status, and whether it is open', async () => {
    page()
    expect(await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })).toBeVisible()
    const head = header()
    expect(within(head).getByText('CRIT')).toBeInTheDocument()
    expect(within(head).getByText('ACTIVE')).toBeInTheDocument()
    expect(within(head).getByText('OPEN')).toBeInTheDocument()
    expect(within(head).getByText('SNMP device')).toBeInTheDocument()
    expect(within(head).getByText('Device unreachable')).toBeInTheDocument()
    expect(within(head).getByText(/Athens DC/)).toBeInTheDocument()
  })

  it('says an acknowledged incident is open', async () => {
    page(setup({ detail: open(incident({ status: 'acknowledged' })) }))
    await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
    expect(within(header()).getByText('ACKNOWLEDGED')).toBeInTheDocument()
    expect(within(header()).getByText('OPEN')).toBeInTheDocument()
    expect(within(header()).queryByText('ENDED')).toBeNull()
  })

  it.each(['recovered', 'closed'] as const)(
    'says a %s incident is ended, not open',
    async (status) => {
      page(setup({ detail: open(incident({ status })) }))
      await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
      expect(within(header()).getByText('ENDED')).toBeInTheDocument()
      expect(within(header()).queryByText('OPEN')).toBeNull()
    },
  )

  it('links back to the list as it was left: search, filters and sort', async () => {
    page(setup(), { pathname: '/alerts/inc-1', state: { list: '?status=ended&sort=name' } })
    await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
    expect(screen.getByRole('link', { name: 'Alerts' })).toHaveAttribute(
      'href',
      '/alerts?status=ended&sort=name',
    )
  })

  it('keeps the scope in the way back when it did not come from the list', async () => {
    page(setup(), '/alerts/inc-1?customer=acme')
    await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
    expect(screen.getByRole('link', { name: 'Alerts' })).toHaveAttribute(
      'href',
      '/alerts?customer=acme',
    )
  })
})

describe('the summary', () => {
  it('says what the status means in a sentence, apart from its word', async () => {
    page()
    const panel = await summary()
    expect(panel).toHaveTextContent('Open and not yet seen by anyone.')
  })

  it('says an acknowledged incident is seen and still open', async () => {
    page(setup({ detail: open(incident({ status: 'acknowledged' })) }))
    const panel = await summary()
    expect(panel).toHaveTextContent(
      'Seen by someone, and still open: the condition has not cleared.',
    )
  })

  it('names the rule, the trigger condition and what the rule says', async () => {
    page()
    const panel = await summary()
    expect(fact(panel, 'Rule')).toHaveTextContent('Device unreachable')
    expect(fact(panel, 'Trigger condition')).toHaveTextContent('Critical · no response to polls')
    expect(panel).toHaveTextContent('Opens when a polled device stops answering for a minute.')
  })

  it('says a rule that is switched off now', async () => {
    page(
      setup({
        detail: detail(incident(), {
          rule: { id: 'rule-1', name: 'Device unreachable', description: '', enabled: false },
        }),
      }),
    )
    expect(fact(await summary(), 'Rule')).toHaveTextContent('This rule is switched off now.')
  })

  it('shows when the condition started and when the incident opened, with their ages', async () => {
    page()
    const panel = await summary()
    expect(fact(panel, 'Started')).toHaveTextContent('12m ago')
    expect(fact(panel, 'Opened')).toHaveTextContent('10m ago')
    expect(fact(panel, 'Started').querySelector('time')).toHaveAttribute('datetime', iso(720))
    expect(fact(panel, 'Opened').querySelector('time')).toHaveAttribute('datetime', iso(600))
    expect(fact(panel, 'Open for')).toHaveTextContent('10m 0s')
  })

  it('says an active incident was not acknowledged, and shows no recovery or closure for it', async () => {
    page()
    const panel = await summary()
    expect(fact(panel, 'Acknowledged')).toHaveTextContent('not yet')
    expect(fact(panel, 'Recovered')).toHaveTextContent('not yet')
    expect(fact(panel, 'Closed')).toHaveTextContent('still open')
  })

  it('shows who acknowledged and when', async () => {
    page(setup({ detail: open(incident({ status: 'acknowledged', acknowledgedBy: 'maria' })) }))
    const panel = await summary()
    expect(fact(panel, 'Acknowledged')).toHaveTextContent('by maria')
    expect(fact(panel, 'Acknowledged')).toHaveTextContent('9m ago')
  })

  it('says an acknowledgement without a recorded name, as it is', async () => {
    page(setup({ detail: open(incident({ status: 'acknowledged', acknowledgedBy: null })) }))
    expect(fact(await summary(), 'Acknowledged')).toHaveTextContent('by someone')
  })

  it('shows a recovery and how long the incident lasted', async () => {
    page(setup({ detail: open(incident({ status: 'recovered' })) }))
    const panel = await summary()
    expect(fact(panel, 'Recovered')).toHaveTextContent('1m ago')
    expect(fact(panel, 'Closed')).toHaveTextContent('30s ago')
    expect(fact(panel, 'Lasted')).toHaveTextContent('9m 30s')
    expect(panel).toHaveTextContent('Ended: the condition cleared and the recovery was confirmed.')
    expect(fact(panel, 'Acknowledged')).toHaveTextContent('never: it ended before anyone did')
  })

  it('says why a closed incident ended without a recovery, and that it never recovered', async () => {
    page(setup({ detail: open(incident({ status: 'closed', closeReason: 'rule_disabled' })) }))
    const panel = await summary()
    expect(fact(panel, 'Closed')).toHaveTextContent('The rule was disabled.')
    expect(panel).toHaveTextContent('Ended without a recovery: monitoring of it ended.')
    expect(fact(panel, 'Recovered')).toHaveTextContent('—')
  })

  it('says an object that was on no site, rather than leaving the place blank', async () => {
    page(setup({ detail: open(incident({ site: false })) }))
    expect(fact(await summary(), 'Site')).toHaveTextContent(/none: the object was on no site/)
  })
})

describe('the monitored object', () => {
  it.each([
    ['server', 's1', '/servers/s1'],
    ['target', 't1', '/network/t1'],
    ['device', 'd1', '/snmp/d1'],
    ['container', 's1:abc', '/docker?focus=s1%3Aabc'],
    ['interface', 'd1:12', '/snmp/d1?interface=12'],
  ] as const)('opens a visible %s on its own page', async (kind, ref, href) => {
    page(setup({ detail: open(incident({ kind, ref, label: 'the-object' })) }))
    const link = within(await summary()).getByRole('link', { name: 'the-object' })
    expect(link).toHaveAttribute('href', href)
  })

  it('opens it with the scope of the view kept', async () => {
    page(
      setup({ detail: open(incident({ kind: 'server', ref: 's1', label: 'srv' })) }),
      '/alerts/inc-1?customer=acme',
    )
    expect(within(await summary()).getByRole('link', { name: 'srv' })).toHaveAttribute(
      'href',
      '/servers/s1?customer=acme',
    )
  })

  it('goes to the object when the link is followed', async () => {
    const user = userEvent.setup()
    page(setup({ detail: open(incident({ kind: 'server', ref: 's1', label: 'srv' })) }))
    await user.click(within(await summary()).getByRole('link', { name: 'srv' }))
    expect(await screen.findByText('server page')).toBeInTheDocument()
  })

  it('offers no link, and says why, for an object the user may not see or that no longer exists', async () => {
    page(
      setup({
        detail: detail(incident({ kind: 'server', ref: 's9', label: 'gone-host' }), {
          entityVisible: false,
        }),
      }),
    )
    const panel = await summary()
    expect(within(panel).queryByRole('link', { name: 'gone-host' })).toBeNull()
    expect(panel).toHaveTextContent('gone-host')
    expect(panel).toHaveTextContent(
      'It no longer exists, or you may not see it: there is no page to open.',
    )
    // The reference is never printed: nothing about the hidden object beyond what the incident recorded.
    expect(panel).not.toHaveTextContent('s9')
  })
})

describe('the timeline', () => {
  it('shows each recorded step as a line, with its words and its time, and nothing between', async () => {
    page(setup({ detail: open(incident({ status: 'recovered' })) }))
    const log = await screen.findByRole('log', { name: 'Incident timeline' })
    const lines = within(log).getAllByRole('listitem')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toHaveTextContent('Opened (critical, no response to polls)')
    expect(lines[1]).toHaveTextContent('Recovery began: the condition cleared (ok)')
    expect(lines[2]).toHaveTextContent('Recovered: the recovery was confirmed (ok)')
    const times = lines.map((line) => line.querySelector('time')?.getAttribute('datetime'))
    expect(times).toEqual([iso(600), iso(90), iso(60)])
  })

  it('nests every step under the opening, and says what it is for a screen reader', async () => {
    page(setup({ detail: open(incident({ status: 'acknowledged' })) }))
    const log = await screen.findByRole('log', { name: 'Incident timeline' })
    const lines = within(log).getAllByRole('listitem')
    expect(lines[0]).not.toHaveAttribute('aria-level')
    expect(lines[1]).toHaveAttribute('aria-level', '2')
    expect(lines[1]).toHaveTextContent('Acknowledged by maria')
    expect(log).toHaveAccessibleDescription(/recorded steps/)
  })

  it('counts the steps in the panel header', async () => {
    page(setup({ detail: open(incident({ status: 'closed' })) }))
    const panel = await screen.findByRole('region', { name: 'Timeline' })
    expect(within(panel).getByText('2')).toBeInTheDocument()
  })

  it('says no step is recorded, and draws none, for an incident with an empty timeline', async () => {
    page(setup({ detail: detail(incident(), { timeline: [] }) }))
    expect(await screen.findByText('No steps recorded')).toBeInTheDocument()
    expect(screen.queryByRole('log')).toBeNull()
  })

  it('is keyboard reachable: one tab stop on the lines, and the arrow keys move between them', async () => {
    const user = userEvent.setup()
    page(setup({ detail: open(incident({ status: 'recovered' })) }))
    const log = await screen.findByRole('log', { name: 'Incident timeline' })
    const lines = within(log).getAllByRole('listitem')
    lines[0]?.focus()
    await user.keyboard('{ArrowDown}')
    expect(lines[1]).toHaveFocus()
  })
})

describe('acknowledging', () => {
  it('offers the button when the API says this user may acknowledge now', async () => {
    page()
    expect(
      await screen.findByRole('button', { name: 'Acknowledge incident on ath-core-sw' }),
    ).toBeInTheDocument()
  })

  it.each(['acknowledged', 'recovered', 'closed'] as const)(
    'offers none on an incident that is %s',
    async (status) => {
      page(setup({ detail: open(incident({ status })) }))
      await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
      expect(screen.queryByRole('button', { name: /^Acknowledge/ })).toBeNull()
    },
  )

  it('says an active incident cannot be acknowledged by this account, and offers no button', async () => {
    page(setup({ detail: open(incident({ canAcknowledge: false })) }))
    await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
    expect(screen.queryByRole('button', { name: /^Acknowledge/ })).toBeNull()
    expect(
      screen.getByText(/Acknowledging needs a permission this account does not have/),
    ).toBeInTheDocument()
  })

  it('shows the incident as the API answered, at once, without resolving it: acknowledged and still open', async () => {
    const user = userEvent.setup()
    const served = page()
    await user.click(await screen.findByRole('button', { name: /^Acknowledge/ }))
    expect(served.acknowledgeIncident).toHaveBeenCalledWith('inc-1')
    await waitFor(() => expect(within(header()).getByText('ACKNOWLEDGED')).toBeInTheDocument())
    expect(within(header()).getByText('OPEN')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Acknowledge/ })).toBeNull()
    const panel = await summary()
    expect(fact(panel, 'Acknowledged')).toHaveTextContent('by ana')
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent(
      'Acknowledged by ana. It stays open until the condition clears.',
    )
  })

  it('reads the incident and the shell’s count again after it, and speaks the outcome', async () => {
    const user = userEvent.setup()
    const served = page()
    await screen.findByRole('button', { name: /^Acknowledge/ })
    const reads = served.getIncident.mock.calls.length
    const overviews = served.getIncidentOverview.mock.calls.length
    await user.click(screen.getByRole('button', { name: /^Acknowledge/ }))
    await waitFor(() => expect(served.getIncident.mock.calls.length).toBeGreaterThan(reads))
    await waitFor(() =>
      expect(served.getIncidentOverview.mock.calls.length).toBeGreaterThan(overviews),
    )
    expect(shell.announce).toHaveBeenCalledWith(expect.stringMatching(/^Acknowledged by ana/))
  })

  it('has a timeline step for the acknowledgement once the API answers with one', async () => {
    const user = userEvent.setup()
    const acknowledged = incident({ status: 'acknowledged', acknowledgedBy: 'maria' })
    page(
      setup({
        ack: async () => detail(acknowledged, { generatedAt: new Date(NOW + 1000).toISOString() }),
      }),
    )
    await user.click(await screen.findByRole('button', { name: /^Acknowledge/ }))
    const log = await screen.findByRole('log', { name: 'Incident timeline' })
    await waitFor(() => expect(within(log).getByText(/Acknowledged by maria/)).toBeInTheDocument())
  })

  it('says it was already acknowledged by someone else, and keeps whoever was first', async () => {
    const user = userEvent.setup()
    page(
      setup({
        ack: async () =>
          detail(incident({ status: 'acknowledged', acknowledgedBy: 'first-person' }), {
            generatedAt: new Date(NOW + 1000).toISOString(),
          }),
      }),
    )
    await user.click(await screen.findByRole('button', { name: /^Acknowledge/ }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Already acknowledged by first-person. It is still open.',
    )
    expect(fact(await summary(), 'Acknowledged')).toHaveTextContent('by first-person')
  })

  it.each([
    [403, 'forbidden', /You may not acknowledge incidents: your account lacks the permission/],
    [404, 'not_found', /no longer exists, or you may no longer see it/],
    [409, 'incident_ended', /already ended, so there is nothing to acknowledge/],
  ] as const)(
    'says a %s plainly, and leaves the incident as it was',
    async (status, code, text) => {
      const user = userEvent.setup()
      page(
        setup({
          ack: async () => {
            throw new ApiError('x', status, code)
          },
        }),
      )
      await user.click(await screen.findByRole('button', { name: /^Acknowledge/ }))
      const notice = await screen.findByRole('alert')
      expect(notice).toHaveTextContent('NOT ACKNOWLEDGED')
      expect(notice).toHaveTextContent(text)
      expect(within(header()).getByText('ACTIVE')).toBeInTheDocument()
    },
  )

  it('says it is not known whether it went through when the server cannot be reached, and lets it be tried again', async () => {
    const user = userEvent.setup()
    const served = page(
      setup({
        ack: async () => {
          throw new ApiError('Cannot reach the server.', null, 'network')
        },
      }),
    )
    await user.click(await screen.findByRole('button', { name: /^Acknowledge/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /not known whether the incident was acknowledged/,
    )
    expect(screen.getByRole('button', { name: /^Acknowledge/ })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: /^Acknowledge/ }))
    await waitFor(() => expect(served.acknowledgeIncident).toHaveBeenCalledTimes(2))
  })

  it('has no way to resolve or close an incident by hand', async () => {
    page()
    await screen.findByRole('heading', { level: 1, name: 'ath-core-sw' })
    expect(screen.queryByRole('button', { name: /resolve|close|dismiss incident/i })).toBeNull()
  })
})

describe('missing and failing', () => {
  it('says the incident is not found for a 404, with the way back, and shows no other incident', async () => {
    page(
      setup({ detail: new ApiError('Not found.', 404, 'not_found') }),
      '/alerts/nope?customer=acme',
    )
    expect(await screen.findByText('Incident not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Alerts' })).toHaveAttribute(
      'href',
      '/alerts?customer=acme',
    )
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
  })

  it('shows the failure in each panel, with Retry, and invents no incident', async () => {
    const user = userEvent.setup()
    const served = page(setup({ detail: new ApiError('Incidents down', 503) }))
    const panel = await screen.findByRole('region', { name: 'Summary' })
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Incidents down')
    expect(screen.queryByRole('heading', { level: 1, name: 'ath-core-sw' })).toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(served.getIncident.mock.calls.length).toBeGreaterThan(1))
  })
})

describe('provenance', () => {
  it('tags both panels live over the console API', async () => {
    page()
    const panel = await summary()
    expect(within(panel).getByText(/^live/)).toBeInTheDocument()
    expect(
      within(await screen.findByRole('region', { name: 'Timeline' })).getByText(/^live/),
    ).toBeInTheDocument()
  })

  it('never says live while the alerts feature is not connected', async () => {
    overrides.set('alerts', { connected: false })
    page()
    expect(within(await summary()).queryByText(/^live/)).toBeNull()
  })
})
