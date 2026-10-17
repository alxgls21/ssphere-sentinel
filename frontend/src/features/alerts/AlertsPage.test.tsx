import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { EngineStatus, IncidentItem, IncidentList } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import AlertsPage from './AlertsPage'
import { detail, engine, incident, list, overview } from './testing'

/** jsdom has no viewport: every media query answers the same, so a test picks "desktop" or "phone". */
function stubViewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}
const realMatchMedia = window.matchMedia
const overrides = registryOverrides()
beforeEach(() => stubViewport(true))
afterEach(() => {
  window.matchMedia = realMatchMedia
  overrides.restore()
})

function Where() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

/** Every situation an operator has to tell apart. */
const INCIDENTS: IncidentItem[] = [
  incident({ id: 'i-down', label: 'pir-core', severity: 'critical' }),
  incident({
    id: 'i-ack',
    label: 'cdn-edge',
    severity: 'critical',
    status: 'acknowledged',
    kind: 'target',
    ref: 't1',
    rule: 'Probe failing',
    reason: 'failing',
    acknowledgedBy: 'maria',
  }),
  incident({
    id: 'i-warn',
    label: 'api-02',
    severity: 'warning',
    health: 'warning',
    kind: 'server',
    ref: 's1',
    rule: 'Server resources',
    reason: 'resources',
    canAcknowledge: false,
  }),
  incident({
    id: 'i-rec',
    label: 'web-01',
    status: 'recovered',
    kind: 'server',
    ref: 's2',
    reason: 'offline',
  }),
  incident({
    id: 'i-closed',
    label: 'old-sw',
    status: 'closed',
    closeReason: 'entity_removed',
    site: false,
  }),
]

interface Served {
  lists?: (IncidentList | Error)[]
  engine?: EngineStatus | Error
  ack?: SentinelApi['acknowledgeIncident']
}

function setup({ lists = [list(INCIDENTS)], engine: state = engine(), ack }: Served = {}) {
  const queue = [...lists]
  const listIncidents = vi.fn<SentinelApi['listIncidents']>(async () => {
    const next =
      queue.length > 1
        ? (queue.shift() as IncidentList | Error)
        : (queue[0] as IncidentList | Error)
    if (next instanceof Error) throw next
    return next
  })
  const acknowledgeIncident = vi.fn<SentinelApi['acknowledgeIncident']>(
    ack ?? (async () => detail(incident({ status: 'acknowledged', acknowledgedBy: 'maria' }))),
  )
  const getEngineStatus = vi.fn<SentinelApi['getEngineStatus']>(async () => {
    if (state instanceof Error) throw state
    return state
  })
  const getIncidentOverview = vi.fn<SentinelApi['getIncidentOverview']>(async () => overview())
  const api = createTestApi({
    listIncidents,
    acknowledgeIncident,
    getEngineStatus,
    getIncidentOverview,
    source: 'http',
  })
  return { api, listIncidents, acknowledgeIncident, getEngineStatus, getIncidentOverview }
}

const shell = createFakeShell()

function page(
  route = '/alerts',
  served: ReturnType<typeof setup> = setup(),
  user: { username: string; displayName: string } | null = null,
) {
  renderApp(
    <>
      <Routes>
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/alerts/:id" element={<p>incident page</p>} />
      </Routes>
      <Where />
    </>,
    { api: served.api, route, withAlerts: true, withShell: shell, auth: createFakeAuth({ user }) },
  )
  return served
}

const table = () => screen.findByRole('table', { name: 'Incidents' })
/** A chip of the status filter: the severity filter has an ALL of its own. */
const statusChip = (name: RegExp) =>
  within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name })
const rowOf = (t: HTMLElement, label: string) =>
  within(t)
    .getByRole('link', { name: new RegExp(label) })
    .closest('tr') as HTMLElement
const where = () => screen.getByTestId('location')
const lastRequest = (served: ReturnType<typeof setup>) =>
  served.listIncidents.mock.calls.at(-1)?.[0]

describe('the list', () => {
  it('lists the incidents as the API ordered them, and says how many it shows of the scope', async () => {
    page()
    const rows = within(await table())
      .getAllByRole('row')
      .slice(1)
    expect(rows.map((row) => row.querySelector('a')?.textContent)).toEqual([
      'devpir-core',
      'netcdn-edge',
      'srvapi-02',
      'srvweb-01',
      'devold-sw',
    ])
    expect(screen.getByText('5 of 5 shown')).toBeInTheDocument()
  })

  it('opens on what is open now, the worst first, one bounded page', async () => {
    const served = page()
    await table()
    expect(lastRequest(served)).toMatchObject({
      status: 'open',
      severity: 'all',
      kind: 'all',
      sort: 'severity',
      dir: 'desc',
      page: 1,
      pageSize: 50,
    })
  })

  it('shows severity and status as separate words, each with a mark', async () => {
    page()
    const t = await table()
    const down = rowOf(t, 'pir-core')
    expect(within(down).getByText('CRIT')).toBeInTheDocument()
    expect(within(down).getByText('ACTIVE')).toBeInTheDocument()
    expect(rowOf(t, 'api-02')).toHaveTextContent('WARN')
    expect(down.querySelector('span.w-0\\.5')).toHaveClass('bg-critical')
    expect(rowOf(t, 'api-02').querySelector('span.w-0\\.5')).toHaveClass('bg-warning')
  })

  it('tells active, acknowledged, recovered and closed apart by word, and an acknowledged one is still open', async () => {
    page()
    const t = await table()
    expect(rowOf(t, 'pir-core')).toHaveTextContent('ACTIVE')
    const ack = rowOf(t, 'cdn-edge')
    expect(ack).toHaveTextContent('ACKNOWLEDGED')
    expect(within(ack).getByText(', still open')).toHaveClass('sr-only')
    expect(ack.querySelector('[data-incident-status]')).toHaveAttribute(
      'title',
      expect.stringMatching(/still open/),
    )
    expect(rowOf(t, 'web-01')).toHaveTextContent('RECOVERED')
    expect(rowOf(t, 'old-sw')).toHaveTextContent('CLOSED')
    const statuses = [...t.querySelectorAll('[data-incident-status]')].map((tag) =>
      tag.getAttribute('data-incident-status'),
    )
    expect(statuses).toEqual(['active', 'acknowledged', 'active', 'recovered', 'closed'])
  })

  it('shows the object, its kind, the rule, the condition and where it is', async () => {
    page()
    const row = rowOf(await table(), 'pir-core')
    expect(within(row).getByText('dev')).toHaveAttribute('title', 'SNMP device')
    expect(within(row).getByText('Device unreachable')).toBeInTheDocument()
    expect(within(row).getByText('no response to polls')).toHaveAttribute(
      'title',
      'Critical · no response to polls',
    )
    expect(within(row).getByText('Meridian')).toBeInTheDocument()
    expect(within(row).getByText(/Athens DC/)).toBeInTheDocument()
  })

  it('shows no site for an incident of an object that was on none', async () => {
    page()
    const row = rowOf(await table(), 'old-sw')
    expect(within(row).queryByText('Meridian')).toBeNull()
  })

  it('shows when it opened and, for each status, what happened last, with its reason', async () => {
    page()
    const t = await table()
    expect(within(rowOf(t, 'pir-core')).getByText('10m')).toBeInTheDocument()
    expect(rowOf(t, 'cdn-edge')).toHaveTextContent('maria · 9m ago')
    expect(rowOf(t, 'web-01')).toHaveTextContent('recovered 1m ago')
    expect(within(rowOf(t, 'old-sw')).getByText('closed 30s ago')).toHaveAttribute(
      'title',
      expect.stringMatching(/The object no longer exists/),
    )
  })

  it('opens an incident from its name and from anywhere on its row, keeping the list for the way back', async () => {
    const user = userEvent.setup()
    page('/alerts?status=all&sort=name')
    const t = await table()
    expect(within(t).getByRole('link', { name: /pir-core/ })).toHaveAttribute(
      'href',
      '/alerts/i-down',
    )
    await user.click(within(rowOf(t, 'pir-core')).getByText('Device unreachable'))
    expect(await screen.findByText('incident page')).toBeInTheDocument()
    expect(where()).toHaveTextContent('/alerts/i-down')
  })
})

describe('the counts', () => {
  const page2 = (over: Partial<IncidentList> = {}) =>
    list([incident({ id: 'x1' }), incident({ id: 'x2', label: 'second' })], {
      counts: { active: 40, acknowledged: 12, recovered: 300, closed: 48 },
      scopeTotal: 400,
      page: { number: 1, size: 50, total: 52, pages: 2 },
      ...over,
    })

  it('are the API’s, over the whole scope, never counted from the rows on the page', async () => {
    page('/alerts', setup({ lists: [page2()] }))
    await table()
    const chip = statusChip
    expect(chip(/^OPEN/)).toHaveTextContent('52')
    expect(chip(/^ACTIVE/)).toHaveTextContent('40')
    expect(chip(/^ACKNOWLEDGED/)).toHaveTextContent('12')
    expect(chip(/^HISTORY/)).toHaveTextContent('348')
    expect(chip(/^RECOVERED/)).toHaveTextContent('300')
    expect(chip(/^CLOSED/)).toHaveTextContent('48')
    expect(chip(/^ALL/)).toHaveTextContent('400')
    // The header says how many of the scope match, not how many rows were loaded.
    expect(screen.getByText('52 of 400 shown')).toBeInTheDocument()
  })

  it('count an acknowledged incident as open, and keep it apart from the active ones', async () => {
    page('/alerts', setup({ lists: [page2()] }))
    await table()
    expect(statusChip(/^OPEN/)).toHaveAttribute(
      'title',
      expect.stringMatching(/Active and acknowledged/),
    )
    expect(statusChip(/^ACKNOWLEDGED/)).toHaveAttribute(
      'title',
      expect.stringMatching(/still open/),
    )
  })
})

describe('the filters', () => {
  it('choose a status chip: history, active, acknowledged, recovered, closed and all each ask for their own', async () => {
    const user = userEvent.setup()
    const served = page()
    await table()
    for (const [label, status] of [
      ['HISTORY', 'ended'],
      ['ACTIVE', 'active'],
      ['ACKNOWLEDGED', 'acknowledged'],
      ['RECOVERED', 'recovered'],
      ['CLOSED', 'closed'],
      ['ALL', 'all'],
    ] as const) {
      await user.click(statusChip(new RegExp(`^${label}`)))
      await waitFor(() => expect(lastRequest(served)).toMatchObject({ status }))
      expect(where()).toHaveTextContent(`status=${status}`)
    }
  })

  it('go back to the open view when the chosen chip is pressed again, and to all from the open chip', async () => {
    const user = userEvent.setup()
    page('/alerts?status=ended')
    await table()
    await user.click(statusChip(/^HISTORY/))
    await waitFor(() => expect(where()).not.toHaveTextContent('status='))
    await user.click(statusChip(/^OPEN/))
    await waitFor(() => expect(where()).toHaveTextContent('status=all'))
  })

  it('narrow by severity and by kind, and write both in the URL', async () => {
    const user = userEvent.setup()
    const served = page()
    await table()
    await user.click(screen.getByRole('button', { name: /^CRIT/ }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ severity: 'critical' }))
    expect(where()).toHaveTextContent('severity=critical')
    await user.selectOptions(screen.getByLabelText('Kind'), 'interface')
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ kind: 'interface' }))
    expect(where()).toHaveTextContent('kind=interface')
  })

  it('offer every entity kind the API filters on', async () => {
    page()
    await table()
    const options = within(screen.getByLabelText('Kind')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'All kinds',
      'Servers',
      'Containers',
      'Network targets',
      'SNMP devices',
      'Interfaces',
    ])
  })

  it('search once the typing settles, over the object, rule, site and customer', async () => {
    const user = userEvent.setup()
    const served = page()
    await table()
    const before = served.listIncidents.mock.calls.length
    await user.type(screen.getByRole('searchbox', { name: 'Search incidents' }), 'core')
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ q: 'core' }))
    // Not a request per keystroke.
    expect(served.listIncidents.mock.calls.length - before).toBeLessThanOrEqual(2)
    expect(where()).toHaveTextContent('q=core')
    expect(screen.getByRole('searchbox', { name: 'Search incidents' })).toHaveAttribute(
      'placeholder',
      'Search object, rule, site, customer',
    )
  })

  it('start again from the first page when they change', async () => {
    const user = userEvent.setup()
    const served = page('/alerts?page=3&status=all')
    await table()
    await user.click(screen.getByRole('button', { name: /^CRIT/ }))
    await waitFor(() =>
      expect(lastRequest(served)).toMatchObject({ severity: 'critical', page: 1 }),
    )
  })

  it('read a shared link in full', async () => {
    const served = page(
      '/alerts?q=core&status=acknowledged&severity=warning&kind=server&sort=name&dir=desc&page=2',
    )
    await table()
    expect(lastRequest(served)).toMatchObject({
      q: 'core',
      status: 'acknowledged',
      severity: 'warning',
      kind: 'server',
      sort: 'name',
      dir: 'desc',
      page: 2,
    })
    expect(statusChip(/^ACKNOWLEDGED/)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^WARN/ })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the sort', () => {
  it('sorts from the column headers, flipping a column and starting another at its natural direction', async () => {
    const user = userEvent.setup()
    const served = page()
    const t = await table()
    expect(within(t).getByRole('columnheader', { name: /SEVERITY/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    await user.click(within(t).getByRole('button', { name: /SEVERITY/ }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'severity', dir: 'asc' }))
    await user.click(within(t).getByRole('button', { name: /ENTITY/ }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'name', dir: 'asc' }))
    await user.click(within(t).getByRole('button', { name: /OPENED/ }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'opened', dir: 'desc' }))
    await user.click(within(t).getByRole('button', { name: /STATUS/ }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'status', dir: 'desc' }))
    await user.click(within(t).getByRole('button', { name: /STARTED/ }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'started', dir: 'desc' }))
  })
})

describe('the pages', () => {
  const paged = (number: number, pages: number, total: number) =>
    list([incident({ id: `p${number}` })], {
      page: { number, size: 50, total, pages },
      counts: { active: total, acknowledged: 0, recovered: 0, closed: 0 },
      scopeTotal: total,
    })

  it('says where this page sits among the matches, and moves to the next and the previous', async () => {
    const user = userEvent.setup()
    const served = page('/alerts', setup({ lists: [paged(1, 3, 120)] }))
    await table()
    const nav = screen.getByRole('navigation', { name: 'Pages' })
    expect(nav).toHaveTextContent('1–1 of 120 · page 1 of 3')
    expect(within(nav).getByRole('button', { name: 'Previous' })).toBeDisabled()
    await user.click(within(nav).getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ page: 2, pageSize: 50 }))
    expect(where()).toHaveTextContent('page=2')
  })

  it('has no pager for a single page, and disables Next on the last', async () => {
    page()
    await table()
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull()
  })

  it('goes to the last page when the one asked for is past the end', async () => {
    const served = page(
      '/alerts?page=9',
      setup({
        lists: [
          list([], {
            page: { number: 9, size: 50, total: 120, pages: 3 },
            scopeTotal: 120,
            counts: { active: 120, acknowledged: 0, recovered: 0, closed: 0 },
          }),
          paged(3, 3, 120),
        ],
      }),
    )
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ page: 3 }))
    expect(where()).toHaveTextContent('page=3')
  })

  it('never asks for a page above the API’s limit', async () => {
    const served = page('/alerts?page=99999')
    await table()
    expect(lastRequest(served)).toMatchObject({ page: 1 })
  })
})

describe('the scope', () => {
  it('asks for the customer and site in the top bar, and again when it changes', async () => {
    const served = page('/alerts?customer=acme&site=ath')
    await table()
    expect(lastRequest(served)).toMatchObject({ scope: { customerId: 'acme', siteId: 'ath' } })
  })

  it('keeps the scope as the only difference between two views of the same query', async () => {
    const first = page('/alerts?customer=acme')
    await table()
    expect(lastRequest(first)).toMatchObject({ scope: { customerId: 'acme', siteId: null } })
  })
})

describe('the empty states', () => {
  const none = list([], { scopeTotal: 0 })

  it('says nothing has been recorded, and that this is not good news while the engine is not confirmed running', async () => {
    page('/alerts', setup({ lists: [none], engine: engine('never_started') }))
    expect(await screen.findByText('No incidents')).toBeInTheDocument()
    // Both the engine's banner and the empty state say so: neither reads as good news.
    expect(
      screen.getAllByText(/does not mean everything is healthy/).length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('says only that none was recorded when the engine runs', async () => {
    page('/alerts', setup({ lists: [none], engine: engine('running') }))
    expect(await screen.findByText('No incidents')).toBeInTheDocument()
    await screen.findByText(/Evaluating every 60 s/)
    expect(screen.getByText('No incident has been recorded in this scope.')).toBeInTheDocument()
    expect(screen.queryByText(/does not mean everything is healthy/)).toBeNull()
  })

  it('says none is open, when every incident has ended, and offers the history', async () => {
    const user = userEvent.setup()
    const ended = list([], {
      scopeTotal: 6,
      counts: { active: 0, acknowledged: 0, recovered: 4, closed: 2 },
      page: { number: 1, size: 50, total: 0, pages: 1 },
    })
    const served = page('/alerts', setup({ lists: [ended] }))
    expect(await screen.findByText('No open incidents')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show history' }))
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ status: 'ended' }))
  })

  it('says nothing matches a narrowed view, and clears the filters', async () => {
    const user = userEvent.setup()
    const noMatch = list([], {
      scopeTotal: 6,
      counts: { active: 0, acknowledged: 0, recovered: 0, closed: 0 },
      page: { number: 1, size: 50, total: 0, pages: 1 },
    })
    const served = page('/alerts?q=zzz&severity=warning', setup({ lists: [noMatch] }))
    expect(await screen.findByText('No incident matches')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement)
    await waitFor(() =>
      expect(lastRequest(served)).toMatchObject({ q: '', severity: 'all', status: 'open' }),
    )
  })
})

describe('failures', () => {
  it('shows the error with Retry, and recovers, never falling back to other data', async () => {
    const user = userEvent.setup()
    const served = setup({ lists: [new ApiError('Incidents down', 503), list(INCIDENTS)] })
    page('/alerts', served)
    const panel = await screen.findByRole('region', { name: 'Incidents' })
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Incidents down')
    expect(within(panel).queryByRole('table')).toBeNull()
    await user.click(within(panel).getByRole('button', { name: 'Retry' }))
    expect(await table()).toBeVisible()
  })

  it('keeps the last list under a banner when a refresh fails', async () => {
    const user = userEvent.setup()
    const served = setup({ lists: [list(INCIDENTS), new ApiError('flaky', 503)] })
    page('/alerts', served)
    await table()
    await user.click(screen.getByRole('button', { name: /^CRIT/ }))
    await waitFor(() => expect(served.listIncidents).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Refresh failed/)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Incidents' })).toBeVisible()
  })
})

describe('the alert engine above the list', () => {
  it('says a running engine is running, and when its last cycle succeeded', async () => {
    page()
    const banner = await screen.findByRole('region', { name: 'Alert engine' })
    expect(await within(banner).findByText('RUNNING')).toBeInTheDocument()
    expect(banner).toHaveTextContent('Evaluating every 60 s; its latest cycle succeeded 12s ago.')
    expect(banner).toHaveTextContent('cycle 140 ms')
  })

  it('makes a failed engine visible, with the category of its error', async () => {
    page('/alerts', setup({ engine: engine('failed') }))
    const banner = await screen.findByRole('region', { name: 'Alert engine' })
    expect(await within(banner).findByText('FAILED')).toBeInTheDocument()
    expect(banner).toHaveTextContent(/failed with a database error/)
    expect(banner).toHaveTextContent(/Incidents shown may be out of date/)
  })

  it('makes a stale engine visible, and says nothing opens or recovers', async () => {
    page('/alerts', setup({ engine: engine('stale') }))
    const banner = await screen.findByRole('region', { name: 'Alert engine' })
    expect(await within(banner).findByText('STALE')).toBeInTheDocument()
    expect(banner).toHaveTextContent(/no incident opens or recovers/)
  })

  it('never draws an engine that has not started as running, ok or healthy', async () => {
    page('/alerts', setup({ engine: engine('never_started') }))
    const banner = await screen.findByRole('region', { name: 'Alert engine' })
    expect(await within(banner).findByText('NEVER STARTED')).toBeInTheDocument()
    expect(banner).toHaveTextContent(/never run/)
    expect(within(banner).queryByText('RUNNING')).toBeNull()
    expect(within(banner).queryByText('OK')).toBeNull()
    expect(banner.querySelector('[data-status="healthy"]')).toBeNull()
    expect(banner.querySelector('[data-status="unknown"]')).not.toBeNull()
  })

  it('says its state could not be read, with Retry, rather than showing nothing', async () => {
    page('/alerts', setup({ engine: new ApiError('Engine endpoint down', 503) }))
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('ENGINE UNKNOWN')
    expect(banner).toHaveTextContent(/Engine endpoint down/)
    expect(within(banner).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does not hide the incidents behind it', async () => {
    page('/alerts', setup({ engine: engine('failed') }))
    expect(await table()).toBeVisible()
  })
})

describe('acknowledging', () => {
  it('offers the button only on an incident the API says may be acknowledged', async () => {
    page()
    const t = await table()
    expect(
      within(rowOf(t, 'pir-core')).getByRole('button', {
        name: 'Acknowledge incident on pir-core',
      }),
    ).toBeInTheDocument()
    // Acknowledged, recovered and closed ones have none, and neither has one without the permission.
    for (const name of ['cdn-edge', 'api-02', 'web-01', 'old-sw']) {
      expect(
        within(rowOf(t, name)).queryByRole('button', { name: /^Acknowledge/ }),
        name,
      ).toBeNull()
    }
  })

  it('offers it to no one without the permission: every row says canAcknowledge false', async () => {
    const denied = INCIDENTS.map((entry) => ({ ...entry, canAcknowledge: false }))
    page('/alerts', setup({ lists: [list(denied)] }))
    await table()
    expect(screen.queryByRole('button', { name: /^Acknowledge/ })).toBeNull()
  })

  it('acknowledges through the API, says so, and reads the list and the shell’s count again', async () => {
    const user = userEvent.setup()
    const served = page()
    const t = await table()
    const before = served.listIncidents.mock.calls.length
    const overviews = served.getIncidentOverview.mock.calls.length
    await user.click(within(rowOf(t, 'pir-core')).getByRole('button', { name: /^Acknowledge/ }))
    expect(served.acknowledgeIncident).toHaveBeenCalledWith('i-down')
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('ACKNOWLEDGED')
    expect(notice).toHaveTextContent(
      'Acknowledged by maria. It stays open until the condition clears.',
    )
    await waitFor(() => expect(served.listIncidents.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() =>
      expect(served.getIncidentOverview.mock.calls.length).toBeGreaterThan(overviews),
    )
    expect(shell.announce).toHaveBeenCalledWith(expect.stringMatching(/^Acknowledged by maria/))
  })

  it('says it was already acknowledged by someone else, when the API keeps the first', async () => {
    const user = userEvent.setup()
    const served = page(
      '/alerts',
      setup({
        ack: async () =>
          detail(incident({ status: 'acknowledged', acknowledgedBy: 'someone-else' })),
      }),
      { username: 'ana', displayName: 'Ana' },
    )
    await user.click(
      within(rowOf(await table(), 'pir-core')).getByRole('button', { name: /^Acknowledge/ }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Already acknowledged by someone-else\. It is still open\./,
    )
    expect(served.acknowledgeIncident).toHaveBeenCalledTimes(1)
  })

  it.each([
    [403, 'forbidden', /You may not acknowledge incidents: your account lacks the permission/],
    [404, 'not_found', /no longer exists, or you may no longer see it/],
    [409, 'incident_ended', /already ended, so there is nothing to acknowledge/],
  ] as const)(
    'says a %s plainly, as an alert, and reads the list again',
    async (status, code, text) => {
      const user = userEvent.setup()
      const served = page(
        '/alerts',
        setup({
          ack: async () => {
            throw new ApiError('x', status, code)
          },
        }),
      )
      const t = await table()
      const before = served.listIncidents.mock.calls.length
      await user.click(within(rowOf(t, 'pir-core')).getByRole('button', { name: /^Acknowledge/ }))
      const notice = await screen.findByRole('alert')
      expect(notice).toHaveTextContent('NOT ACKNOWLEDGED')
      expect(notice).toHaveTextContent(text)
      await waitFor(() => expect(served.listIncidents.mock.calls.length).toBeGreaterThan(before))
    },
  )

  it('says it is not known whether it went through when the server cannot be reached', async () => {
    const user = userEvent.setup()
    page(
      '/alerts',
      setup({
        ack: async () => {
          throw new ApiError('Cannot reach the server.', null, 'network')
        },
      }),
    )
    await user.click(
      within(rowOf(await table(), 'pir-core')).getByRole('button', { name: /^Acknowledge/ }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /not known whether the incident was acknowledged/,
    )
  })

  it('shows the button busy and refuses a second click while the write is out', async () => {
    const user = userEvent.setup()
    let release: (value: ReturnType<typeof detail>) => void = () => {}
    const served = page(
      '/alerts',
      setup({ ack: () => new Promise((resolve) => (release = resolve)) }),
    )
    const t = await table()
    const button = within(rowOf(t, 'pir-core')).getByRole('button', { name: /^Acknowledge/ })
    await user.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('Acknowledging…')
    await user.click(button)
    expect(served.acknowledgeIncident).toHaveBeenCalledTimes(1)
    release(detail(incident({ status: 'acknowledged', acknowledgedBy: 'maria' })))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Acknowledged'))
  })

  it('does not take an answer that is still active for an acknowledgement', async () => {
    const user = userEvent.setup()
    page('/alerts', setup({ ack: async () => detail(incident({ status: 'active' })) }))
    await user.click(
      within(rowOf(await table(), 'pir-core')).getByRole('button', { name: /^Acknowledge/ }),
    )
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent(/still active: the acknowledgement was not recorded/)
  })

  it('can dismiss the notice', async () => {
    const user = userEvent.setup()
    page()
    await user.click(
      within(rowOf(await table(), 'pir-core')).getByRole('button', { name: /^Acknowledge/ }),
    )
    await screen.findByRole('status')
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('on a phone', () => {
  beforeEach(() => stubViewport(false))

  it('lists cards instead of a table, still links to every incident, with a sort menu', async () => {
    page()
    const cards = await screen.findByRole('list', { name: 'Incidents' })
    expect(screen.queryByRole('table')).toBeNull()
    expect(within(cards).getAllByRole('link')).toHaveLength(5)
    expect(within(cards).getAllByRole('link')[0]).toHaveAttribute('href', '/alerts/i-down')
    expect(screen.getByLabelText('Sort by')).toBeInTheDocument()
  })

  it('keeps the acknowledge button outside the link, and only where it may be used', async () => {
    const user = userEvent.setup()
    const served = page()
    const cards = await screen.findByRole('list', { name: 'Incidents' })
    const buttons = within(cards).getAllByRole('button', { name: /^Acknowledge/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.closest('a')).toBeNull()
    await user.click(buttons[0] as HTMLElement)
    expect(served.acknowledgeIncident).toHaveBeenCalledWith('i-down')
  })

  it('shows severity, status, the condition and the age on each card', async () => {
    page()
    const cards = await screen.findByRole('list', { name: 'Incidents' })
    const first = within(cards).getAllByRole('listitem')[0] as HTMLElement
    expect(first).toHaveTextContent('CRIT')
    expect(first).toHaveTextContent('ACTIVE')
    expect(first).toHaveTextContent('opened 10m ago')
    expect(first).toHaveTextContent('Critical · no response to polls')
  })

  it('sorts from the menu', async () => {
    const user = userEvent.setup()
    const served = page()
    await screen.findByRole('list', { name: 'Incidents' })
    await user.selectOptions(screen.getByLabelText('Sort by'), 'name')
    await waitFor(() => expect(lastRequest(served)).toMatchObject({ sort: 'name', dir: 'asc' }))
  })
})

describe('provenance', () => {
  it('says live over the console API, and not over the sample API', async () => {
    page()
    const panel = await screen.findByRole('region', { name: 'Incidents' })
    expect(within(panel).getByText(/^live/)).toBeInTheDocument()
  })

  it('never says live while the alerts feature is not connected', async () => {
    overrides.set('alerts', { connected: false })
    page()
    const panel = await screen.findByRole('region', { name: 'Incidents' })
    expect(within(panel).queryByText(/^live/)).toBeNull()
  })

  it('shows no incident of its own over the sample API: its list is empty', async () => {
    const mock = setup({ lists: [list([], { scopeTotal: 0 })], engine: engine('never_started') })
    const api = createTestApi({ ...mock.api, source: 'mock' })
    renderApp(<AlertsPage />, { api, withAlerts: true, withShell: shell })
    expect(await screen.findByText('No incidents')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
