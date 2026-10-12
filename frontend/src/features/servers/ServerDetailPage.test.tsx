import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@/api/mock/client'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
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

beforeEach(() => resetFakeCharts())

describe('ServerDetailPage', () => {
  it('names the server, its status and where it lives', async () => {
    page('srv-ath-db-01')
    expect(await screen.findByRole('heading', { level: 1, name: 'ath-db-01' })).toBeVisible()
    expect(screen.getByText('DISK', { selector: '[data-status] span' })).toBeInTheDocument()
    expect(screen.getByText('10.20.2.10')).toBeVisible()
    expect(screen.getByText('Debian 13')).toBeVisible()
    expect(screen.getByText('Meridian Logistics')).toBeInTheDocument()
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
    expect(screen.getByText(/History is sample data/)).toBeVisible()
  })

  describe('a server that stopped reporting', () => {
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
