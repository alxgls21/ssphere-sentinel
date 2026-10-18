import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleHttp } from '@/api/http'
import { createMockApi } from '@/api/mock/client'
import { ApiError } from '@/api/errors'
import type { ContainerList, DeviceList, IncidentList, ServerList, TargetList } from '@/api/types'
import { createConsoleApi } from '@/app/consoleApi'
import { engine, incident, list as incidentList } from '@/features/alerts/testing'
import { item as deviceItem } from '@/features/snmp/testing'
import { OVERVIEW_PAGE_SIZE } from '@/lib/overview'
import { emptyCounts } from '@/lib/status'
import { renderApp } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import OverviewPage from './OverviewPage'

const NOW = Date.parse('2026-10-12T14:05:12Z')

function stubViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width: 64rem'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function setup(wide = true, api = createMockApi({ delayMs: 0, now: () => NOW })) {
  stubViewport(wide)
  return {
    api,
    ...renderApp(<OverviewPage />, {
      api,
      withSummary: true,
      withAlerts: true,
      withShell: true,
    }),
  }
}

afterEach(() => vi.unstubAllGlobals())

// jsdom applies no CSS, so the wide hero and the phone bar are both in the DOM: use the hero.
const strip = () => screen.getByRole('region', { name: 'Fleet summary' })
const loaded = () => within(strip()).findByText('CRITICAL')
const loadedStrip = () => within(strip()).findByRole('button', { name: /^Fleet status:/ })

describe('OverviewPage', () => {
  it('shows the six panels and the summary strip, in reading order', async () => {
    setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    for (const name of [
      'Fleet summary',
      'Needs attention',
      'Network latency',
      'Fleet load',
      'Infrastructure health',
      'Active alerts',
      'Recent events',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument()
    }
    // Each panel is reachable by its number key.
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(document.querySelector(`[data-panel="${index}"]`)).not.toBeNull()
    }
    await loaded()
  })

  it('says the same thing everywhere: the verdict, the queue and the tiles agree', async () => {
    const { api } = setup()
    const summary = await api.getOverviewSummary({})
    const attention = (['servers', 'containers'] as const).reduce(
      (sum, domain) =>
        sum +
        summary[domain].counts.critical +
        summary[domain].counts.warning +
        summary[domain].counts.unknown,
      0,
    )
    const queue = await screen.findByRole('region', { name: 'Needs attention' })
    await waitFor(() => expect(within(queue).getAllByRole('row').length).toBeGreaterThan(1))
    const hero = await within(strip()).findByRole('button', { name: /^Fleet status:/ })
    expect(hero.querySelector('.type-hero')).toHaveTextContent(String(attention))
    // The queue's header count is the same number of entities.
    expect(within(queue).getByText(String(attention))).toBeInTheDocument()
  })

  it('marks the panels with no backend data as unavailable, and the real ones as mock over the sample API', async () => {
    setup()
    await loaded()
    for (const name of ['Network latency', 'Recent events']) {
      expect(screen.getByRole('region', { name })).toHaveAttribute('data-planned', 'true')
    }
    for (const name of ['Needs attention', 'Fleet load', 'Active alerts']) {
      const region = screen.getByRole('region', { name })
      expect(region).not.toHaveAttribute('data-planned')
      expect(within(region).getByText(/^mock/)).toBeInTheDocument()
    }
  })

  it('holds no figure, chart or sample row in the panels the console API cannot fill', async () => {
    setup()
    await loaded()
    for (const name of ['Network latency', 'Recent events']) {
      const region = screen.getByRole('region', { name })
      expect(region.querySelector('canvas, svg[role="img"], table, [role="row"]')).toBeNull()
      expect(
        within(region).getAllByText(/^(Not implemented|Not connected)/).length,
      ).toBeGreaterThan(0)
    }
  })

  it('reads only what the console API serves: no request for alerts, events or network series', async () => {
    const api = createMockApi({ delayMs: 0, now: () => NOW })
    expect(Object.keys(api).sort()).toEqual(
      [
        'acknowledgeIncident',
        'getEngineStatus',
        'getEntityIndex',
        'getFleetLoad',
        'getHealthBreakdown',
        'getOverviewSummary',
        'getScopeOptions',
        'getServer',
        'getIncident',
        'getIncidentOverview',
        'getInterfaceSeries',
        'getServerSeries',
        'getDevice',
        'getDeviceSeries',
        'getTarget',
        'getTargetSeries',
        'getTopology',
        'listAttention',
        'listContainers',
        'listDevices',
        'listIncidents',
        'listTargets',
        'listServers',
        'createAlertRule',
        'getAlertRule',
        'getAlertRuleOptions',
        'getNotificationSettings',
        'getSystemStatus',
        'getTestEmail',
        'listAlertRules',
        'requestTestEmail',
        'saveNotificationPreferences',
        'updateAlertRule',
        'source',
      ].sort(),
    )
    setup(true, api)
    await loaded()
  })

  it('keeps the page alive when one panel fails: it errors alone, with its own Retry', async () => {
    const api = createMockApi({ delayMs: 0, now: () => NOW })
    api.getFleetLoad = () => Promise.reject(new ApiError('load service down', 503))
    setup(true, api)
    const load = screen.getByRole('region', { name: 'Fleet load' })
    expect(await within(load).findByRole('alert')).toHaveTextContent('load service down')
    expect(within(load).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // Everything else is still there.
    expect(await loaded()).toBeInTheDocument()
    const queue = screen.getByRole('region', { name: 'Needs attention' })
    await waitFor(() => expect(within(queue).getAllByRole('row').length).toBeGreaterThan(1))
  })

  it('folds the PLANNED panels into one collapsed section on a narrow screen', async () => {
    setup(false)
    await loaded()
    const folded = screen.getByText(/Planned · backend not implemented \(1\)/)
    const section = folded.closest('details') as HTMLDetailsElement
    expect(section.open).toBe(false)
    // The alerts are real, so they stay outside the fold; only the events are folded.
    expect(
      within(section).queryByRole('region', { name: 'Active alerts', hidden: true }),
    ).toBeNull()
    expect(screen.getByRole('region', { name: 'Active alerts' })).toBeInTheDocument()
    expect(
      within(section).getByRole('region', { name: 'Recent events', hidden: true }),
    ).toBeInTheDocument()
    await userEvent.click(folded)
    expect(section.open).toBe(true)
  })

  it('shows the PLANNED panels inline on a wide screen, with no accordion', async () => {
    setup(true)
    await loaded()
    expect(screen.queryByText(/Planned · backend not implemented/)).not.toBeInTheDocument()
  })
})

describe('OverviewPage over the console API, with SNMP devices', () => {
  const generatedAt = new Date(Date.parse('2026-10-17T10:00:00Z')).toISOString()
  const page = { number: 1, size: OVERVIEW_PAGE_SIZE, total: 0, pages: 1 }
  const quiet = <T extends ServerList | ContainerList | TargetList>(healthy: number) =>
    ({
      generatedAt,
      items: [],
      page,
      counts: { ...emptyCounts(), healthy },
      scopeTotal: healthy,
    }) as unknown as T

  const down = deviceItem({
    id: 'dev-down',
    name: 'pir-core',
    reason: 'unreachable',
    interfaces: { unknown: 48 },
  })
  const fine = deviceItem({
    id: 'dev-ok',
    name: 'ath-core-sw',
    reason: 'ok',
    interfaces: { healthy: 20, warning: 4, idle: 2 },
  })
  const devices = (over: Partial<DeviceList> = {}): DeviceList => ({
    generatedAt,
    items: [down, fine],
    page,
    counts: { ...emptyCounts(), healthy: 24, critical: 1, unknown: 3, idle: 2 },
    scopeTotal: 30,
    ...over,
  })

  function mount(listDevices: ConsoleHttp['listDevices']) {
    const http = {
      auth: {},
      getScopeOptions: vi.fn(async () => ({ customers: [], sites: [] })),
      listServers: vi.fn(async () => quiet<ServerList>(5)),
      listContainers: vi.fn(async () => quiet<ContainerList>(5)),
      listTargets: vi.fn(async () => quiet<TargetList>(0)),
      listDevices: vi.fn(listDevices),
      listIncidents: vi.fn(async () => incidentList([])),
      getEngineStatus: vi.fn(async () => engine()),
      getFleetLoad: vi.fn(async () => ({ generatedAt, rows: [], excluded: [] })),
    } as unknown as ConsoleHttp & { listDevices: ReturnType<typeof vi.fn> }
    stubViewport(true)
    const api = createConsoleApi(http)
    renderApp(<OverviewPage />, { api, withSummary: true, withAlerts: true, withShell: true })
    return http
  }

  it('counts the devices in the tile from the API’s scope total and counts, and links to SNMP', async () => {
    mount(async () => devices())
    const link = await within(strip()).findByRole('link', { name: /^Devices: / })
    expect(link).toHaveAccessibleName('Devices: 24 of 30 ok, 1 critical, 3 unknown, 2 idle')
    expect(link).toHaveAttribute('href', '/snmp')
    expect(within(link).getByText('/30 ok')).toBeInTheDocument()
    expect(within(link.closest('section, div') as HTMLElement).queryByText('mock')).toBeNull()
  })

  it('counts the devices into the verdict by their health, never by an interface', async () => {
    mount(async () => devices())
    // 1 critical + 3 unknown devices; the 4 down interfaces of a healthy device add nothing.
    const hero = await within(strip()).findByRole('button', { name: /^Fleet status: critical/i })
    expect(hero.querySelector('.type-hero')).toHaveTextContent('4')
    expect(hero).toHaveAccessibleName(/4 need attention of 38/)
  })

  it('lists the device that needs attention, links it to its page, and counts the rest as not listed', async () => {
    mount(async () => devices())
    const queue = screen.getByRole('region', { name: 'Needs attention' })
    const row = (await within(queue).findByText('pir-core')).closest('tr') as HTMLElement
    expect(row).toHaveAccessibleName(
      /critical, dev pir-core, Switch 10\.20\.0\.250, no response: timeout/,
    )
    // 4 device problems exist and one is in the rows.
    expect(within(queue).getByText(/3 more need attention and are not listed/)).toBeVisible()
    // The healthy device with ports down is not a problem of its own.
    expect(within(queue).queryByText('ath-core-sw')).toBeNull()
    await userEvent.click(row)
  })

  it('shows the devices in the health panel, with the interfaces labelled partial while the rows are not all of them', async () => {
    stubFocusVisible()
    const user = userEvent.setup()
    mount(async () => devices())
    const health = screen.getByRole('region', { name: 'Infrastructure health' })
    const row = (await within(health).findByText('SNMP DEVS')).closest('li') as HTMLElement
    expect(
      within(row).getByRole('img', { name: 'SNMP devices: 1 critical, 3 unknown, 2 idle, 24 ok' }),
    ).toBeInTheDocument()
    await user.click(row)
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('74 interfaces on the first 2 devices of 30')
    expect(tip).toHaveTextContent(/Partial: .* not a total for the scope/)
  })

  it('tags the SNMP tile, the queue and the health panel live over the console API', async () => {
    mount(async () => devices())
    await within(strip()).findByRole('link', { name: /^Devices: / })
    expect(within(strip()).getAllByText('live').length).toBeGreaterThanOrEqual(4)
    expect(
      within(screen.getByRole('region', { name: 'Needs attention' })).getByText(/^live/),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Infrastructure health' })).getByText(/^live/),
    ).toBeInTheDocument()
  })

  it('says none are monitored, and draws no device figure, for a scope without devices', async () => {
    mount(async () => devices({ items: [], counts: emptyCounts(), scopeTotal: 0 }))
    const link = await within(strip()).findByRole('link', { name: /^Devices: / })
    expect(link).toHaveAccessibleName('Devices: 0 of 0 ok')
    expect(link).toHaveTextContent('none monitored')
    const health = screen.getByRole('region', { name: 'Infrastructure health' })
    const row = (await within(health).findByText('SNMP DEVS')).closest('li') as HTMLElement
    expect(within(row).getByText('none')).toBeInTheDocument()
  })

  it('shows the failure, and no sample, when the devices cannot be read', async () => {
    mount(async () => {
      throw new ApiError('SNMP devices are down', 503)
    })
    const queue = screen.getByRole('region', { name: 'Needs attention' })
    expect(await within(queue).findByRole('alert')).toHaveTextContent('SNMP devices are down')
    expect(within(strip()).queryByRole('link', { name: /^Devices: / })).toBeNull()
    expect(within(strip()).getAllByRole('alert').length).toBeGreaterThan(0)
    expect(screen.queryByText('pir-core')).toBeNull()
  })

  it('asks once for the devices of the topbar scope, one bounded page', async () => {
    stubViewport(true)
    const http = mount(async () => devices())
    await within(strip()).findByRole('link', { name: /^Devices: / })
    expect(http.listDevices).toHaveBeenCalledTimes(1)
    expect(http.listDevices).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: OVERVIEW_PAGE_SIZE,
        sort: 'status',
        dir: 'desc',
      }),
    )
  })
})

describe('OverviewPage over the console API, with incidents', () => {
  const generatedAt = new Date(Date.parse('2026-10-18T10:00:00Z')).toISOString()
  const page = { number: 1, size: OVERVIEW_PAGE_SIZE, total: 0, pages: 1 }
  const quiet = <T extends ServerList | ContainerList | TargetList | DeviceList>(healthy: number) =>
    ({
      generatedAt,
      items: [],
      page,
      counts: { ...emptyCounts(), healthy },
      scopeTotal: healthy,
    }) as unknown as T

  const critical = incident({ id: 'inc-c', label: 'pir-core', severity: 'critical' })
  const acked = incident({
    id: 'inc-a',
    label: 'cdn-edge',
    severity: 'critical',
    status: 'acknowledged',
    kind: 'target',
    ref: 't1',
  })
  const warning = incident({ id: 'inc-w', label: 'api-02', severity: 'warning', health: 'warning' })

  interface Served {
    open?: IncidentList | Error
    criticalCount?: IncidentList
    engine?: ReturnType<typeof engine> | Error
  }

  function mount({
    open = incidentList([critical, acked, warning], {
      counts: { active: 5, acknowledged: 2, recovered: 9, closed: 4 },
      scopeTotal: 20,
    }),
    criticalCount = incidentList([], {
      counts: { active: 2, acknowledged: 1, recovered: 0, closed: 0 },
    }),
    engine: state = engine(),
  }: Served = {}) {
    const listIncidents = vi.fn(async (options: { severity?: string }) => {
      const answer = options.severity === 'critical' ? criticalCount : open
      if (answer instanceof Error) throw answer
      return answer
    })
    const http = {
      auth: {},
      getScopeOptions: vi.fn(async () => ({ customers: [], sites: [] })),
      listServers: vi.fn(async () => quiet<ServerList>(5)),
      listContainers: vi.fn(async () => quiet<ContainerList>(5)),
      listTargets: vi.fn(async () => quiet<TargetList>(0)),
      listDevices: vi.fn(async () => quiet<DeviceList>(0)),
      listIncidents,
      getEngineStatus: vi.fn(async () => {
        if (state instanceof Error) throw state
        return state
      }),
      getFleetLoad: vi.fn(async () => ({ generatedAt, rows: [], excluded: [] })),
    } as unknown as ConsoleHttp
    stubViewport(true)
    const api = createConsoleApi(http)
    renderApp(<OverviewPage />, {
      api,
      withSummary: true,
      withAlerts: true,
      withShell: true,
      route: '/?customer=acme',
    })
    return { listIncidents, http }
  }

  const panel = () => screen.getByRole('region', { name: 'Active alerts' })
  const tile = () => within(strip()).findByRole('link', { name: /^Alerts: / })

  it('counts the open incidents in the tile and the panel from the API’s counts over the whole scope', async () => {
    mount()
    expect(await tile()).toHaveAccessibleName('Alerts: 7 open, 3 critical, 5 not acknowledged')
    expect(await within(panel()).findByText('open')).toBeInTheDocument()
    expect(panel()).toHaveTextContent('7 open')
    expect(panel()).toHaveTextContent('3 critical')
    expect(panel()).toHaveTextContent('5 not acknowledged')
  })

  it('lists the first few, critical first, each opening its incident, and counts the rest as not listed', async () => {
    mount()
    const rows = await within(panel()).findByRole('list', { name: 'Recent important incidents' })
    const links = within(rows).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/alerts/inc-c?customer=acme',
      '/alerts/inc-a?customer=acme',
      '/alerts/inc-w?customer=acme',
    ])
    expect(links[0]).toHaveTextContent('pir-core')
    // Active and acknowledged stay apart, and an acknowledged one is listed as an open incident.
    expect(links[0]).toHaveTextContent('ACTIVE')
    expect(links[1]).toHaveTextContent('ACKNOWLEDGED')
    // 7 are open and 3 are listed.
    expect(panel()).toHaveTextContent('+4 more open')
    expect(within(panel()).getByRole('link', { name: 'All alerts' })).toHaveAttribute(
      'href',
      '/alerts?customer=acme',
    )
  })

  it('lists at most three rows, whatever the first page holds', async () => {
    const many = Array.from({ length: 5 }, (_, n) => incident({ id: `m${n}`, label: `host-${n}` }))
    mount({
      open: incidentList(many, {
        counts: { active: 40, acknowledged: 0, recovered: 0, closed: 0 },
        scopeTotal: 40,
      }),
    })
    const rows = await within(panel()).findByRole('list', { name: 'Recent important incidents' })
    expect(within(rows).getAllByRole('link')).toHaveLength(3)
    expect(panel()).toHaveTextContent('40 open')
    expect(panel()).toHaveTextContent('+37 more open')
  })

  it('asks for two bounded pages in the topbar scope, and no incident one by one', async () => {
    const { listIncidents } = mount()
    await tile()
    expect(listIncidents).toHaveBeenCalledTimes(2)
    for (const [options] of listIncidents.mock.calls) {
      expect(options).toMatchObject({
        scope: { customerId: 'acme', siteId: null },
        status: 'open',
        page: 1,
      })
      expect((options as { pageSize: number }).pageSize).toBeLessThanOrEqual(5)
    }
  })

  it('says no incident is open, without calling it good news, when the engine has never run', async () => {
    mount({
      open: incidentList([], {
        counts: { active: 0, acknowledged: 0, recovered: 0, closed: 0 },
        scopeTotal: 0,
      }),
      criticalCount: incidentList([]),
      engine: engine('never_started'),
    })
    expect(await within(panel()).findByText(/No open incidents recorded/)).toHaveTextContent(
      /does not mean everything is healthy/,
    )
    expect(panel()).toHaveTextContent('NEVER STARTED')
    expect(await tile()).toHaveAccessibleName(/alert engine never started/)
  })

  it('says only that none is open, with the engine running', async () => {
    mount({
      open: incidentList([], {
        counts: { active: 0, acknowledged: 0, recovered: 3, closed: 0 },
        scopeTotal: 3,
      }),
      criticalCount: incidentList([]),
    })
    expect(await within(panel()).findByText('No open incidents.')).toBeInTheDocument()
    expect(panel()).toHaveTextContent('alert engine running')
    expect(panel()).not.toHaveTextContent('NEVER STARTED')
  })

  it.each([
    ['failed', 'FAILED'],
    ['stale', 'STALE'],
  ] as const)('shows a %s engine in the panel, above the incidents', async (state, word) => {
    mount({ engine: engine(state) })
    expect(await within(panel()).findByText(word)).toBeInTheDocument()
    expect(within(panel()).getByRole('list', { name: 'Recent important incidents' })).toBeVisible()
  })

  it('shows the failure in the panel and the tile, with no sample count, when the incidents cannot be read', async () => {
    mount({ open: new ApiError('Incidents down', 503) })
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Incidents down')
    expect(within(strip()).queryByRole('link', { name: /^Alerts: / })).toBeNull()
    expect(within(panel()).queryByRole('list')).toBeNull()
  })

  it('keeps the rest of the Overview alive when the alerts fail', async () => {
    mount({ open: new ApiError('Incidents down', 503) })
    await within(panel()).findByRole('alert')
    expect(await loadedStrip()).toBeInTheDocument()
  })

  it('tags the tile and the panel live over the console API, never over the sample API', async () => {
    mount()
    await tile()
    expect(within(await tile()).getByText('live')).toBeInTheDocument()
    expect(within(panel()).getByText(/^live/)).toBeInTheDocument()
  })

  it('shows no incident of its own over the sample API: none open, and an engine that never ran', async () => {
    setup()
    await loaded()
    const link = await within(strip()).findByRole('link', { name: /^Alerts: / })
    expect(link).toHaveAccessibleName(
      /^Alerts: 0 open, 0 critical, 0 not acknowledged, alert engine never started/,
    )
    expect(within(panel()).getByText(/^mock/)).toBeInTheDocument()
    expect(within(panel()).queryByRole('list', { name: 'Recent important incidents' })).toBeNull()
    expect(panel()).toHaveTextContent('NEVER STARTED')
  })

  it('does not count open incidents into the verdict: they follow the health already counted', async () => {
    mount()
    const hero = await within(strip()).findByRole('button', { name: /^Fleet status:/ })
    // The 10 servers and containers are all healthy; seven open incidents change nothing.
    expect(hero).toHaveAccessibleName(/nominal/i)
  })
})
