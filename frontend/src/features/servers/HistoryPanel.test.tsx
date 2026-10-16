import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSeries } from '@/api/types'
import { createMockApi } from '@/api/mock/client'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
import { registryOverrides } from '@/config/testing'
import type { Resource } from '@/hooks/useResource'
import { createTestApi, renderApp } from '@/test/render'
import { HistoryPanel } from './HistoryPanel'

vi.mock('@/charts/echarts', async () =>
  (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule(),
)

const NOW = Date.parse('2026-10-12T14:00:00Z')
const api = createMockApi({ now: () => NOW, delayMs: 0 })

const overrides = registryOverrides()

beforeEach(() => resetFakeCharts())
afterEach(() => overrides.restore())

const resource = (over: Partial<Resource<ServerSeries>> = {}): Resource<ServerSeries> => ({
  status: 'success',
  data: undefined,
  error: null,
  isRefreshing: false,
  updatedAt: NOW,
  refetch: vi.fn(),
  ...over,
})

const panel = (given: Resource<ServerSeries>, route = '/', source: 'mock' | 'http' = 'mock') =>
  renderApp(<HistoryPanel index={2} resource={given} name="ath-db-01" />, {
    route,
    api: createTestApi({ source }),
  })

const DEMO_FOOTER = /the console API serves this history, but this screen is not connected/

const series = () => api.getServerSeries({ serverId: 'srv-ath-db-01', range: '1h' })

describe('HistoryPanel', () => {
  it('draws the series it is given, over the range in the URL, with the footer that says it is demo data', async () => {
    panel(resource({ data: await series() }), '/?range=6h')
    const region = screen.getByRole('region', { name: 'Resource history' })
    expect(region).toHaveTextContent('6h')
    expect(await screen.findByRole('figure')).toHaveAccessibleName(/Resource history of ath-db-01/)
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
    expect(
      screen.getByText(/the console API serves this history, but this screen is not connected/),
    ).toBeVisible()
    expect(screen.getByText(/^mock/)).toBeInTheDocument()
  })

  it('keeps saying it is demo data while the servers are served over http but not read from it', async () => {
    panel(resource({ data: await series() }), '/', 'http')
    expect(screen.getByText(DEMO_FOOTER)).toBeVisible()
    expect(screen.getByText(/^mock/)).toBeInTheDocument()
    expect(await screen.findByRole('figure')).toBeInTheDocument()
  })

  it('has no demo footer, and is tagged live, once the servers are connected and served over http', async () => {
    overrides.set('servers', { connected: true })
    panel(resource({ data: await series() }), '/', 'http')
    expect(await screen.findByRole('figure')).toBeInTheDocument()
    expect(screen.getByText(/^live/)).toBeInTheDocument()
    expect(screen.queryByText(/Demo data/)).toBeNull()
    expect(screen.queryByText(/^mock/)).toBeNull()
  })

  it('says so, instead of drawing an empty chart, when no sample falls in the range', async () => {
    const full = await series()
    const silent = {
      ...full,
      cpu: full.cpu.map(() => null),
      memory: full.memory.map(() => null),
      disk: full.disk.map(() => null),
    }
    panel(resource({ data: silent }))
    expect(screen.getByText('No history')).toBeVisible()
    expect(screen.queryByRole('figure')).toBeNull()
  })

  it('keeps the chart on screen, dimmed, while another range loads', async () => {
    panel(resource({ data: await series(), isRefreshing: true }))
    expect(await screen.findByRole('figure')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Resource history' })).not.toHaveAttribute(
      'aria-busy',
    )
    expect(screen.getByRole('figure').closest('div.opacity-60')).not.toBeNull()
  })

  it('shows its loading state without a chart before the first series arrives', () => {
    panel(resource({ status: 'loading' }))
    expect(screen.getByRole('region', { name: 'Resource history' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
    expect(screen.queryByRole('figure')).toBeNull()
  })

  it('shows its own error with Retry, wired to the shared request', () => {
    const refetch = vi.fn()
    panel(
      resource({
        status: 'error',
        error: new Error('Service unavailable'),
        updatedAt: null,
        refetch,
      }),
    )
    expect(screen.getByText('Could not load resource history')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
