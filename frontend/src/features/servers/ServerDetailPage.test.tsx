import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { createMockApi } from '@/api/mock/client'
import type { ServerTelemetry } from '@/api/types'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import ServerDetailPage from './ServerDetailPage'

vi.mock('@/charts/echarts', async () =>
  (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule(),
)

const NOW = Date.parse('2026-10-12T14:00:00Z')
const mock = (scenario: Parameters<typeof createMockApi>[0] = {}) =>
  createMockApi({ now: () => NOW, delayMs: 0, ...scenario })

const page = (id: string, api = mock(), search = '', state?: unknown) =>
  renderApp(
    <Routes>
      <Route path="/servers" element={<p>servers list</p>} />
      <Route path="/servers/:id" element={<ServerDetailPage />} />
    </Routes>,
    { api, route: `/servers/${id}${search}` },
  ) && state

const overrides = registryOverrides()

beforeEach(() => resetFakeCharts())
afterEach(() => overrides.restore())

describe('ServerDetailPage', () => {
  it('names the server, its status and where it lives', async () => {
    page('srv-ath-db-01')
    expect(await screen.findByRole('heading', { level: 1, name: 'ath-db-01' })).toBeVisible()
    expect(screen.getByText('DISK', { selector: '[data-status] span' })).toBeInTheDocument()
    expect(screen.getByText('10.20.2.10')).toBeVisible()
    expect(screen.getByText('Debian 13')).toBeVisible()
    expect(screen.getByText('Meridian Logistics')).toBeInTheDocument()
  })

  it('keeps the indicator of a server that is reporting', async () => {
    page('srv-ath-db-01')
    const heading = await screen.findByRole('heading', { level: 1, name: 'ath-db-01' })
    expect(heading.parentElement?.querySelector('span[data-status]')).toHaveAttribute(
      'data-status',
      'warning',
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('links back to the list, keeping the view', async () => {
    page('srv-ath-db-01', mock(), '?range=6h')
    await screen.findByRole('heading', { level: 1, name: 'ath-db-01' })
    expect(screen.getByRole('link', { name: 'Servers' })).toHaveAttribute(
      'href',
      '/servers?range=6h',
    )
  })

  it('summarises the latest reading with real sizes, as meters', async () => {
    page('srv-ath-db-01')
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(
      await within(summary).findByRole('meter', { name: 'Disk of ath-db-01' }),
    ).toBeInTheDocument()
    expect(within(summary).getByText(/of 1000 GiB/)).toBeVisible()
    expect(within(summary).getByText('143d 0h')).toBeVisible()
  })

  it('lists its containers, worst first, with the words operators use', async () => {
    page('srv-ath-db-01')
    const table = await screen.findByRole('table', { name: 'Containers' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('UNHEALTHY')
    expect(rows[0]).toHaveTextContent('pgbouncer')
    expect(rows[1]).toHaveTextContent('RUNNING')
  })

  it('draws the history from the range in the URL, and gives the chart its table twin', async () => {
    const real = mock()
    const getServerSeries = vi.fn((options) => real.getServerSeries(options))
    page('srv-ath-db-01', createTestApi({ ...real, getServerSeries }), '?range=6h')
    const figure = await screen.findByRole('figure')
    expect(figure).toHaveAccessibleName(/Resource history of ath-db-01, last 6 hours/)
    expect(getServerSeries).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'srv-ath-db-01', range: '6h' }),
    )
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
    // The console API serves this history; the screen is not connected to it yet, and says exactly that.
    expect(
      screen.getByText(/the console API serves this history, but this screen is not connected/),
    ).toBeVisible()
    expect(screen.queryByText(/backend keeps only the latest/)).toBeNull()
  })

  describe('a server that stopped reporting', () => {
    it('is tagged offline in its header, apart from critical, and says OFFLINE', async () => {
      page('srv-pir-fs-01')
      const heading = await screen.findByRole('heading', { level: 1, name: 'pir-fs-01' })
      const tag = within(heading.parentElement as HTMLElement)
        .getByText('OFFLINE')
        .closest('[data-status]')
      expect(tag).toHaveAttribute('data-status', 'offline')
      expect(tag?.querySelector('svg')).toHaveAttribute('data-status', 'offline')
      expect(tag).toHaveClass('bg-offline-tint', 'text-offline')
    })

    it('frames its notice as offline, not critical', async () => {
      page('srv-pir-fs-01')
      const notice = await screen.findByRole('status')
      expect(notice).toHaveClass('border-offline-line', 'bg-offline-tint')
      expect(notice.className).not.toContain('critical')
      expect(notice.querySelector('[data-status]')).toHaveAttribute('data-status', 'offline')
      expect(notice.querySelector('svg')).toHaveAttribute('data-status', 'offline')
    })

    it('says so first, shows the last reading, and cannot vouch for its containers', async () => {
      page('srv-pir-fs-01')
      const notice = await screen.findByRole('status')
      expect(notice).toHaveTextContent('The agent stopped reporting at')
      expect(screen.getByRole('region', { name: 'Summary' })).toHaveTextContent('LAST READING')
      const table = await screen.findByRole('table', { name: 'Containers' })
      expect(within(table).getAllByText('UNKNOWN').length).toBeGreaterThan(0)
      expect(screen.getByText(/Host offline: container state cannot be observed/)).toBeVisible()
    })
  })

  describe('a server that never reported', () => {
    it('explains that there is nothing to show instead of drawing empty charts', async () => {
      page('srv-core-ci-01')
      expect(await screen.findByRole('status')).toHaveTextContent('has never reported')
      expect(await screen.findByText('No history')).toBeVisible()
      expect(screen.queryByRole('figure')).toBeNull()
      expect(await screen.findByText('No containers reported')).toBeVisible()
    })
  })

  it('answers an unknown server with a way back, not a blank page', async () => {
    page('srv-nope')
    expect(await screen.findByText('Server not found')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Back to Servers' })).toHaveAttribute(
      'href',
      '/servers',
    )
  })

  it('fails panel by panel, each with its own Retry', async () => {
    const user = userEvent.setup()
    const real = mock()
    const getServer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Service unavailable'))
      .mockImplementation((id, options) => real.getServer(id, options))
    page('srv-ath-db-01', createTestApi({ ...real, getServer }))
    expect(await screen.findByText('Could not load summary')).toBeInTheDocument()
    expect(screen.getByText('Could not load containers')).toBeInTheDocument()
    // The history comes from another request: it is unaffected.
    expect(await screen.findByRole('figure')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0]!)
    expect(await screen.findByRole('heading', { level: 1, name: 'ath-db-01' })).toBeVisible()
  })

  it('shows the loading state without moving the frame', async () => {
    const never = new Promise<never>(() => {})
    page(
      'srv-ath-db-01',
      createTestApi({
        getServer: vi.fn(() => never),
        getServerSeries: vi.fn(() => never),
      }),
    )
    expect(screen.getByRole('region', { name: 'Summary' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('region', { name: 'Resource history' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })
})

describe('ServerDetailPage resource sparklines', () => {
  const sparks = (root: HTMLElement) => within(root).queryAllByRole('img', { name: /history of/ })

  /** The mock api with its series request counted; `getServerSeries` keeps answering for real. */
  function counted() {
    const real = mock()
    const getServerSeries = vi.fn((options) => real.getServerSeries(options))
    return { real, getServerSeries, api: createTestApi({ ...real, getServerSeries }) }
  }

  it('draws CPU, RAM and disk history in the Summary, from the series the history panel shows, requested once', async () => {
    const { real, getServerSeries, api } = counted()
    page('srv-ath-db-01', api)
    const summary = await screen.findByRole('region', { name: 'Summary' })
    await screen.findByRole('figure')
    const found = await within(summary).findAllByRole('img', { name: /history of ath-db-01/ })
    expect(found.map((spark) => spark.getAttribute('aria-label')?.split(':')[0])).toEqual([
      'CPU history of ath-db-01, last hour',
      'RAM history of ath-db-01, last hour',
      'Disk history of ath-db-01, last hour',
    ])
    expect(getServerSeries).toHaveBeenCalledTimes(1)
    // The newest value is the one the chart ends on.
    const series = await real.getServerSeries({ serverId: 'srv-ath-db-01', range: '1h' })
    expect(found[0]).toHaveAccessibleName(new RegExp(`now ${series.cpu.at(-1)} percent`))
    expect(found[0]).toHaveAccessibleName(/13:00 to 13:59 UTC/)
  })

  it('follows the range in the URL with the same single request', async () => {
    const { getServerSeries, api } = counted()
    page('srv-ath-db-01', api, '?range=6h')
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(
      await within(summary).findAllByRole('img', { name: /history of ath-db-01, last 6 hours/ }),
    ).toHaveLength(3)
    expect(getServerSeries).toHaveBeenCalledTimes(1)
    expect(getServerSeries).toHaveBeenCalledWith(expect.objectContaining({ range: '6h' }))
  })

  it('shows the meters at once and leaves each sparkline place empty while the series loads', async () => {
    page(
      'srv-ath-db-01',
      createTestApi({ ...mock(), getServerSeries: vi.fn(() => new Promise<never>(() => {})) }),
    )
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(await within(summary).findByRole('meter', { name: 'CPU of ath-db-01' })).toBeVisible()
    expect(within(summary).getByRole('meter', { name: 'Disk of ath-db-01' })).toBeVisible()
    expect(sparks(summary)).toHaveLength(0)
    expect(within(summary).queryByText('no history')).toBeNull()
    expect(summary.querySelectorAll('[aria-hidden="true"].h-6.w-16')).toHaveLength(3)
  })

  it('keeps the Summary whole when only the series fails, and the history panel says so', async () => {
    const real = mock()
    page(
      'srv-ath-db-01',
      createTestApi({
        ...real,
        getServerSeries: vi.fn(() => Promise.reject(new Error('Service unavailable'))),
      }),
    )
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(await within(summary).findByRole('meter', { name: 'Disk of ath-db-01' })).toBeVisible()
    expect(await screen.findByText('Could not load resource history')).toBeInTheDocument()
    expect(screen.queryByText('Could not load summary')).toBeNull()
    expect(sparks(summary)).toHaveLength(0)
    expect(summary.querySelectorAll('[aria-hidden="true"].h-6.w-16')).toHaveLength(3)
  })

  it('stops calling the newest sample "now" once the series can no longer be refreshed', async () => {
    const real = mock()
    // The test decides when refreshes start failing, so it never depends on how fast the runner is.
    let refreshFails = false
    const getServerSeries = vi.fn(async (options: Parameters<typeof real.getServerSeries>[0]) => {
      if (refreshFails) throw new Error('Service unavailable')
      return real.getServerSeries(options)
    })
    renderApp(
      <Routes>
        <Route path="/servers/:id" element={<ServerDetailPage />} />
      </Routes>,
      {
        api: createTestApi({ ...real, getServerSeries }),
        route: '/servers/srv-ath-db-01',
        pollMs: 30,
      },
    )
    const summary = await screen.findByRole('region', { name: 'Summary' })
    const found = await within(summary).findAllByRole('img', { name: /history of ath-db-01/ })
    expect(found[0]).toHaveAccessibleName(/, now \d+(\.\d)? percent/)

    refreshFails = true
    await waitFor(() => expect(screen.getByText('Refresh failed')).toBeInTheDocument())
    await waitFor(() =>
      expect(sparks(summary)[0]).toHaveAccessibleName(/, last \d+(\.\d)? percent/),
    )
    for (const spark of sparks(summary)) {
      expect(spark).not.toHaveAccessibleName(/now/)
      expect(spark.querySelector('circle.fill-primary')).toBeNull()
    }
  })

  it('draws a host that stopped reporting up to its last sample, then an explicit no-samples tail', async () => {
    const { getServerSeries, api } = counted()
    page('srv-pir-fs-01', api)
    const summary = await screen.findByRole('region', { name: 'Summary' })
    const found = await within(summary).findAllByRole('img', { name: /history of pir-fs-01/ })
    expect(found).toHaveLength(3)
    for (const spark of found) {
      expect(spark).toHaveAccessibleName(/no samples since 13:46 UTC$/)
      expect(spark.querySelector('path[stroke-dasharray]')).not.toBeNull()
      expect(spark.querySelector('.fill-primary')).toBeNull()
    }
    expect(summary).toHaveTextContent('LAST READING')
    expect(getServerSeries).toHaveBeenCalledTimes(1)
  })

  it('has none for a server that never reported, and still asks for the series once', async () => {
    const { getServerSeries, api } = counted()
    page('srv-core-ci-01', api)
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(await screen.findByText('No history')).toBeVisible()
    expect(within(summary).queryAllByRole('meter')).toHaveLength(0)
    expect(sparks(summary)).toHaveLength(0)
    expect(summary.querySelectorAll('[aria-hidden="true"].h-6.w-16')).toHaveLength(0)
    expect(getServerSeries).toHaveBeenCalledTimes(1)
  })

  it("never shows one server's history under another server's name", async () => {
    const real = mock()
    const never = new Promise<never>(() => {})
    const getServerSeries = vi.fn((options) =>
      options.serverId === 'srv-ath-db-01' ? real.getServerSeries(options) : never,
    )
    renderApp(
      <Routes>
        <Route
          path="/servers/:id"
          element={
            <>
              <ServerDetailPage />
              <Link to="/servers/srv-ath-app-01">other server</Link>
            </>
          }
        />
      </Routes>,
      { api: createTestApi({ ...real, getServerSeries }), route: '/servers/srv-ath-db-01' },
    )
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(
      await within(summary).findAllByRole('img', { name: /history of ath-db-01/ }),
    ).toHaveLength(3)
    await userEvent.click(screen.getByRole('link', { name: 'other server' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'ath-app-01' })).toBeVisible()
    const next = screen.getByRole('region', { name: 'Summary' })
    expect(await within(next).findByRole('meter', { name: 'CPU of ath-app-01' })).toBeVisible()
    expect(sparks(next)).toHaveLength(0)
    expect(screen.queryByRole('figure')).toBeNull()
  })

  describe('provenance', () => {
    it('sit in panels tagged mock while the screen shows demo data', async () => {
      page('srv-ath-db-01')
      const summary = await screen.findByRole('region', { name: 'Summary' })
      const history = await screen.findByRole('region', { name: 'Resource history' })
      const found = await within(summary).findAllByRole('img', { name: /history of/ })
      expect(found).toHaveLength(3)
      for (const spark of found) expect(spark.closest('section')).toBe(summary)
      expect(within(summary).getByText('mock')).toBeInTheDocument()
      expect(within(history).getByText(/^mock/)).toBeInTheDocument()
      expect(within(history).getByText(/^Demo data:/)).toBeInTheDocument()
      expect(summary).not.toHaveTextContent(/live/i)
    })

    it('sit in panels tagged live once the servers are connected and served over http', async () => {
      overrides.set('servers', { connected: true })
      page('srv-ath-db-01', createTestApi({ ...mock(), source: 'http' }))
      const summary = await screen.findByRole('region', { name: 'Summary' })
      const history = await screen.findByRole('region', { name: 'Resource history' })
      const found = await within(summary).findAllByRole('img', { name: /history of/ })
      expect(found).toHaveLength(3)
      for (const spark of found) expect(spark.closest('section')).toBe(summary)
      expect(within(summary).getByText('live')).toBeInTheDocument()
      expect(within(summary).queryByText('mock')).toBeNull()
      expect(within(history).getByText(/^live/)).toBeInTheDocument()
      expect(within(history).queryByText(/Demo data/)).toBeNull()
      // The containers come with the server detail, so they are as live as it is.
      expect(
        within(screen.getByRole('region', { name: 'Containers' })).getByText(/^live/),
      ).toBeInTheDocument()
    })
  })
})

describe('ServerDetailPage over the console API', () => {
  /** A server whose heartbeats go on while its newest resource reading has gone stale. */
  async function apiWith(
    telemetry: Partial<ServerTelemetry> | null,
    status: 'online' | 'warning' = 'online',
  ) {
    const real = mock()
    const detail = await real.getServer('srv-ath-db-01')
    const base = detail.item.server.telemetry
    const server = {
      ...detail.item.server,
      status,
      telemetry: telemetry === null || base === null ? null : { ...base, ...telemetry },
    }
    return createTestApi({
      source: 'http',
      getServer: vi.fn(async () => ({
        ...detail,
        item: { ...detail.item, health: 'unknown' as const, server },
      })),
      getServerSeries: (options) => real.getServerSeries(options),
    })
  }

  it('says a stale reading is not the present value, and labels the meters as the last reading', async () => {
    page('srv-ath-db-01', await apiWith({ stale: true, receivedAt: '2026-10-12T13:50:00Z' }))
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('STALE')
    expect(notice).toHaveTextContent('not the present values')
    expect(notice).toHaveTextContent('13:50:00Z (10m ago)')
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('LAST READING')).toBeInTheDocument()
    expect(within(summary).queryByText('NOW')).toBeNull()
  })

  it('shows no notice, and NOW, for a current reading', async () => {
    page('srv-ath-db-01', await apiWith({ stale: false }))
    await screen.findByRole('heading', { level: 1, name: 'ath-db-01' })
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('NOW')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says the agent reports but no reading has arrived, instead of showing empty meters as zero', async () => {
    page('srv-ath-db-01', await apiWith(null))
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('NO READING')
    expect(notice).toHaveTextContent('no resource reading has arrived yet')
  })

  it('is tagged live over http once the servers are connected', async () => {
    page('srv-ath-db-01', await apiWith({ stale: false }))
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(within(summary).getByText(/^live/)).toBeInTheDocument()
    expect(within(summary).queryByText(/^mock/)).toBeNull()
  })

  it('is tagged mock over http while the servers are not read from the console API', async () => {
    overrides.set('servers', { connected: false })
    page('srv-ath-db-01', await apiWith({ stale: false }))
    const summary = await screen.findByRole('region', { name: 'Summary' })
    expect(within(summary).getByText(/^mock/)).toBeInTheDocument()
  })

  it('tags the containers of the server live with the server', async () => {
    page('srv-ath-db-01', await apiWith({ stale: false }))
    const containers = await screen.findByRole('region', { name: 'Containers' })
    expect(within(containers).getByText(/^live/)).toBeInTheDocument()
  })

  it('links the containers of the server to the Docker inventory limited to this host', async () => {
    page('srv-ath-db-01', await apiWith({ stale: false }))
    const containers = await screen.findByRole('region', { name: 'Containers' })
    expect(within(containers).getByRole('link', { name: /Docker/ })).toHaveAttribute(
      'href',
      '/docker?server=srv-ath-db-01',
    )
  })

  it('shows the failure, not another server, when the server cannot be read', async () => {
    const api = createTestApi({
      source: 'http',
      getServer: vi.fn(async () => {
        throw new ApiError('Cannot reach the server.', null, 'network')
      }),
      getServerSeries: vi.fn(async () => {
        throw new ApiError('Cannot reach the server.', null, 'network')
      }),
    })
    page('6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11', api)
    expect((await screen.findAllByText('Cannot reach the server.')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { level: 1, name: 'ath-db-01' })).toBeNull()
  })

  it('says the server is not found for a 404, as the console API answers an unknown or hidden id', async () => {
    const api = createTestApi({
      source: 'http',
      getServer: vi.fn(async () => {
        throw new ApiError('Not found.', 404, 'not_found')
      }),
      getServerSeries: vi.fn(async () => {
        throw new ApiError('Not found.', 404, 'not_found')
      }),
    })
    page('00000000-0000-0000-0000-000000000000', api)
    expect(await screen.findByText('Server not found')).toBeInTheDocument()
  })
})
