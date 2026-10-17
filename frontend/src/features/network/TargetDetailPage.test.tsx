import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { TargetDetail, TargetListItem, TargetSeries } from '@/api/types'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import TargetDetailPage from './TargetDetailPage'
import { detail, item, iso, measurement, series } from './testing'

vi.mock('@/charts/echarts', async () =>
  (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule(),
)

const overrides = registryOverrides()
beforeEach(() => resetFakeCharts())
afterEach(() => overrides.restore())

interface Served {
  detail?: TargetDetail | Error
  series?: TargetSeries | Error
}

function apiFor({ detail: d, series: s = series() }: Served, source: 'http' | 'mock' = 'http') {
  const getTarget = vi.fn<SentinelApi['getTarget']>(async () => {
    if (d instanceof Error) throw d
    return d as TargetDetail
  })
  const getTargetSeries = vi.fn<SentinelApi['getTargetSeries']>(async () => {
    if (s instanceof Error) throw s
    return s
  })
  return { api: createTestApi({ getTarget, getTargetSeries, source }), getTarget, getTargetSeries }
}

const page = (api: SentinelApi, search = '', id = 'tgt-1') =>
  renderApp(
    <Routes>
      <Route path="/network" element={<p>network list</p>} />
      <Route path="/network/:id" element={<TargetDetailPage />} />
      <Route path="/servers/:id" element={<p>server page</p>} />
    </Routes>,
    { api, route: `/network/${id}${search}` },
  )

const showing = (entry: TargetListItem, over: Partial<TargetDetail> = {}, extra: Served = {}) =>
  apiFor({ detail: detail(entry, over), ...extra })

const summary = () => screen.findByRole('region', { name: 'Summary' })

describe('identity and configuration', () => {
  it('names the target, its status word and where it is, and links back keeping the view', async () => {
    const { api } = showing(item())
    page(api, '?range=6h')
    expect(await screen.findByRole('heading', { level: 1, name: 'ath-gateway' })).toBeVisible()
    const header = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement
    expect(within(header).getByText('OK')).toBeInTheDocument()
    expect(screen.getAllByText('Meridian').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute(
      'href',
      '/network?range=6h',
    )
  })

  it('shows the configuration: endpoint, protocol, schedule, circuit and site', async () => {
    const { api } = showing(item({ protocol: 'tcp' }))
    page(api)
    const panel = await summary()
    const fact = (label: string) =>
      within(panel).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement
    expect(fact('Target')).toHaveTextContent('api.example.net:443')
    expect(fact('Protocol')).toHaveTextContent('TCP 443')
    expect(fact('Monitoring')).toHaveTextContent('every 60 s, timeout 5 s')
    expect(fact('Circuit')).toHaveTextContent('CIR-0042')
    expect(fact('Site')).toHaveTextContent('Athens DC')
  })

  it('says monitoring is switched off for a disabled target, and shows no schedule', async () => {
    const { api } = showing(item({ reason: 'disabled' }))
    page(api)
    const panel = await summary()
    expect(
      within(panel).getByText('Monitoring', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('switched off')
  })
})

describe('the agent', () => {
  it('names the agent, its status and last heartbeat, and links to its server', async () => {
    const user = userEvent.setup()
    const { api } = showing(item())
    page(api)
    const panel = await summary()
    const link = within(panel).getByRole('link', { name: 'ath-probe' })
    expect(link).toHaveAttribute('href', '/servers/srv-ath-probe')
    expect(link).toHaveAttribute('title', 'Open ath-probe-01')
    expect(within(panel).getByText('online', { selector: 'dd' })).toBeInTheDocument()
    expect(within(panel).getByText('30s ago')).toBeInTheDocument()
    await user.click(link)
    expect(await screen.findByText('server page')).toBeInTheDocument()
  })

  it('gives no link where the API gave no server id: an agent the user may not see', async () => {
    const { api } = showing(item({ agent: 'hidden' }))
    page(api)
    const panel = await summary()
    expect(within(panel).queryByRole('link', { name: 'ath-probe' })).toBeNull()
    expect(
      within(panel).getByText('Agent', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('assigned')
  })

  it('says none is assigned, and links nothing', async () => {
    const { api } = showing(item({ agent: 'none', reason: 'no_agent' }))
    page(api)
    const panel = await summary()
    expect(
      within(panel).getByText('Agent', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('none assigned')
    expect(within(panel).queryByRole('link')).toBeNull()
  })

  it('names an offline agent as offline', async () => {
    const { api } = showing(item({ agent: 'offline', reason: 'agent_offline' }))
    page(api)
    const panel = await summary()
    expect(within(panel).getByText('offline', { selector: 'dd' })).toBeInTheDocument()
  })
})

describe('metric semantics by protocol', () => {
  it('calls the metric packet loss for an ICMP target, everywhere it is named', async () => {
    const { api } = showing(item({ latest: measurement({ lossPercent: 2 }) }))
    page(api)
    const panel = await summary()
    expect(within(panel).getByText('Packet loss', { selector: 'dt' })).toBeInTheDocument()
    expect(within(panel).getByText('2.0% lost')).toBeInTheDocument()
    expect(within(panel).getByText('4 of 4 probe packets answered')).toBeInTheDocument()
    const recent = await screen.findByRole('table', { name: 'Recent measurements' })
    expect(within(recent).getByRole('columnheader', { name: 'PACKET LOSS' })).toBeInTheDocument()
    expect(within(recent).getByText('2.0% lost')).toBeInTheDocument()
  })

  it('calls it failed connection attempts for a TCP target, and never packet loss', async () => {
    const { api } = showing(
      item({
        protocol: 'tcp',
        latest: measurement({ lossPercent: 2, probeCount: 3, successfulProbes: 3 }),
      }),
    )
    page(api)
    const panel = await summary()
    expect(
      within(panel).getByText('Failed connection attempts', { selector: 'dt' }),
    ).toBeInTheDocument()
    expect(within(panel).getByText('2.0% failed')).toBeInTheDocument()
    expect(within(panel).getByText('3 of 3 connection attempts answered')).toBeInTheDocument()
    const recent = await screen.findByRole('table', { name: 'Recent measurements' })
    expect(
      within(recent).getByRole('columnheader', { name: 'FAILED CONNECTION ATTEMPTS' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/packet/i)
  })

  it('words a TCP loss reason as failed attempts', async () => {
    const entry = item({ protocol: 'tcp', reason: 'loss', latest: measurement({ lossPercent: 6 }) })
    const { api } = showing(entry)
    page(api)
    const panel = await summary()
    expect(within(panel).getByText(/6\.0% of connection attempts failed/)).toBeInTheDocument()
    expect(within(panel).getByText('FAILURES')).toBeInTheDocument()
  })
})

describe('health, reason and staleness', () => {
  it('says the API’s reason beside the status, for a failing target', async () => {
    const entry = item({
      reason: 'failing',
      latest: measurement({
        success: false,
        latencyMs: null,
        lossPercent: 100,
        successfulProbes: 0,
        failureReason: 'timeout',
      }),
    })
    const { api } = showing(entry)
    page(api)
    const panel = await summary()
    expect(within(panel).getByText('FAILING')).toBeInTheDocument()
    expect(within(panel).getByText('The latest measurements all failed.')).toBeInTheDocument()
    expect(
      within(panel).getByText('Failure', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('timeout')
    expect(within(panel).getByRole('region', { name: 'Current measurement' })).toBeInTheDocument()
    // A current reading needs no notice above the panels.
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('quotes the failures in a row from the limits the API published', async () => {
    const { api } = showing(item({ reason: 'failing' }))
    page(api)
    expect(await screen.findByText('The latest measurements all failed.')).toBeInTheDocument()
  })

  it.each([
    ['disabled', 'DISABLED', /switched off/],
    ['no_agent', 'NO AGENT', /No agent is assigned/],
    ['agent_offline', 'AGENT OFFLINE', /disabled or has stopped reporting/],
    ['no_measurement', 'NO DATA', /Nothing has been measured yet/],
    ['stale', 'STALE', /too old to describe the present/],
  ] as const)(
    'puts a notice above everything for a %s target, in its own words',
    async (reason, word, sentence) => {
      const { api } = showing(
        item({
          reason,
          agent: reason === 'no_agent' ? 'none' : 'online',
          latest: reason === 'stale' ? measurement({ measuredAt: iso(7200) }) : undefined,
        }),
      )
      page(api)
      const notice = await screen.findByRole('status')
      expect(within(notice).getByText(word)).toBeInTheDocument()
      expect(notice).toHaveTextContent(sentence)
    },
  )

  it('shows a stale measurement as the last one, not current, with its own age', async () => {
    const { api } = showing(
      item({ reason: 'stale', latest: measurement({ measuredAt: iso(7200), latencyMs: 9 }) }),
    )
    page(api)
    const panel = await summary()
    const last = within(panel).getByRole('region', { name: 'Last measurement' })
    expect(within(last).getByText('NOT CURRENT')).toBeInTheDocument()
    expect(within(last).getByText('2h ago')).toBeInTheDocument()
    expect(within(panel).queryByRole('region', { name: 'Current measurement' })).toBeNull()
    expect(screen.getByText('LAST MEASUREMENT')).toBeInTheDocument()
  })

  it('says nothing has been measured, with no measurement block, for a target never measured', async () => {
    const { api } = showing(item({ reason: 'no_measurement', latest: null }), { measurements: [] })
    page(api)
    const panel = await summary()
    expect(within(panel).getAllByText('Nothing has been measured yet.').length).toBeGreaterThan(0)
    expect(within(panel).queryByRole('region', { name: /measurement/ })).toBeNull()
    expect(await screen.findByText('No measurements')).toBeInTheDocument()
  })
})

describe('observed availability', () => {
  it('shows the success rate of the measurements taken, and coverage apart', async () => {
    const { api } = showing(item())
    page(api)
    const panel = await screen.findByRole('region', { name: 'Observed availability' })
    expect(within(panel).getByText('99.5%')).toBeInTheDocument()
    expect(within(panel).getByText('observed success rate')).toBeInTheDocument()
    expect(within(panel).getByText('99.5% of 1,400 measurements succeeded')).toBeInTheDocument()
    expect(
      within(panel).getByText('97% of the window measured (1,400 of 1,440 expected)'),
    ).toBeInTheDocument()
    expect(within(panel).getByText('24h')).toBeInTheDocument()
  })

  it('says it is an observation and never an SLA, an uptime or a guarantee of one', async () => {
    const { api } = showing(item())
    page(api)
    const panel = await screen.findByRole('region', { name: 'Observed availability' })
    expect(panel).toHaveTextContent(/an observation, not an SLA or an uptime guarantee/)
    expect(panel.textContent?.replace(/not an SLA or an uptime guarantee/, '')).not.toMatch(
      /\bsla\b|uptime|guarantee|compliance/i,
    )
    expect(screen.queryByText(/uptime/i, { selector: 'h2, dt' })).toBeNull()
  })

  it('shows a dash and says there are no measurements, never 0% or 100%, for an unmeasured day', async () => {
    const { api } = showing(item({ reason: 'no_measurement', latest: null }), {
      measurements: [],
      availability24h: {
        from: iso(86_400),
        to: iso(0),
        measurements: 0,
        successful: 0,
        percent: null,
        expectedMeasurements: 1440,
        coveragePercent: 0,
      },
    })
    page(api)
    const panel = await screen.findByRole('region', { name: 'Observed availability' })
    expect(within(panel).getByText('—', { selector: '.type-kpi' })).toBeInTheDocument()
    expect(within(panel).getByText('No measurements in the last 24 hours')).toBeInTheDocument()
    expect(within(panel).queryByText(/^(0|100)%$/)).toBeNull()
  })
})

describe('recent measurements', () => {
  it('lists them newest first as reported, with the failure reason of a failed round', async () => {
    const rows = [
      measurement({ measuredAt: iso(20), latencyMs: 11 }),
      measurement({
        measuredAt: iso(80),
        success: false,
        latencyMs: null,
        lossPercent: 100,
        successfulProbes: 0,
        failureReason: 'host unreachable',
      }),
    ]
    const { api } = showing(item(), { measurements: rows })
    page(api)
    const table = await screen.findByRole('table', { name: 'Recent measurements' })
    const body = within(table).getAllByRole('row').slice(1)
    expect(body).toHaveLength(2)
    expect(body[0]).toHaveTextContent('answered')
    expect(body[0]).toHaveTextContent('11 ms')
    expect(body[1]).toHaveTextContent('host unreachable')
    expect(body[1]).toHaveTextContent('100% lost')
    expect(body[1]).toHaveTextContent('0/4')
  })
})

describe('history', () => {
  it('asks for the range in the URL and draws it with a table twin', async () => {
    const { api, getTargetSeries } = showing(item(), {}, { series: series() })
    page(api, '?range=6h')
    const figure = await screen.findByRole('figure')
    expect(figure).toHaveAccessibleName(
      /Latency and packet loss history of ath-gateway, last 6 hours/,
    )
    expect(getTargetSeries).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'tgt-1', range: '6h' }),
    )
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
  })

  it('names the loss series for a TCP target as failed connection attempts', async () => {
    const { api } = showing(item({ protocol: 'tcp' }), {}, { series: series() })
    page(api)
    const figure = await screen.findByRole('figure')
    expect(figure).toHaveAccessibleName(/failed connection attempts history of ath-gateway/)
    expect(within(figure).getByText('Failed connection attempts')).toBeInTheDocument()
    expect(within(figure).queryByText('Packet loss')).toBeNull()
  })

  it('says there is no history for a range with no measurement, and draws no chart', async () => {
    const empty = series({ measurements: [0, 0, 0, 0, 0, 0], failed: [0, 0, 0, 0, 0, 0] })
    const { api } = showing(item(), {}, { series: empty })
    page(api)
    expect(await screen.findByText('No history')).toBeInTheDocument()
    expect(screen.queryByRole('figure')).toBeNull()
  })

  it('fails on its own: the rest of the page stays, with its own Retry', async () => {
    const { api } = showing(item(), {}, { series: new ApiError('History down', 503) })
    page(api)
    const panel = await screen.findByRole('region', { name: 'History' })
    expect(await within(panel).findByRole('alert')).toHaveTextContent('History down')
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(await summary()).toBeVisible()
  })
})

describe('missing, failing and provenance', () => {
  it('says the target is not found for a 404, with the way back', async () => {
    const { api } = apiFor({ detail: new ApiError('Not found.', 404) })
    page(api, '', 'nope')
    expect(await screen.findByText('Target not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Network' })).toHaveAttribute(
      'href',
      '/network',
    )
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
  })

  it('shows the failure and no other target when it cannot be read', async () => {
    const { api } = apiFor({ detail: new ApiError('Cannot reach the server.', null, 'network') })
    page(api)
    expect((await screen.findAllByText('Cannot reach the server.')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { level: 1, name: 'ath-gateway' })).toBeNull()
  })

  it('tags every panel live over the console API, and none live over the sample API', async () => {
    const live = page(showing(item()).api)
    await summary()
    const panels = ['Summary', 'History', 'Observed availability', 'Recent measurements']
    for (const name of panels) {
      expect(
        within(screen.getByRole('region', { name })).getByText(/^live/),
        name,
      ).toBeInTheDocument()
    }
    live.unmount()
    page(apiFor({ detail: detail(item()) }, 'mock').api)
    await summary()
    for (const name of panels) {
      expect(within(screen.getByRole('region', { name })).queryByText(/^live/), name).toBeNull()
    }
  })

  it('is not live while the Network feature is not connected', async () => {
    overrides.set('network', { connected: false })
    page(showing(item()).api)
    const panel = await summary()
    expect(within(panel).queryByText(/^live/)).toBeNull()
  })
})
