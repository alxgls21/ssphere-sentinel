/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkSeries } from '@/api/types'
import { createMockApi } from '@/api/mock/client'
import { useRange } from '@/app/viewState'
import { echarts } from '@/charts/echarts'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
import { DATA_FEATURES } from '@/config/features'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import { NetworkLatencyPanel } from './NetworkLatencyPanel'
import { describeSample, spikeIndexes, worstSpikeIndex } from './latencyModel'
import { makeEmptySeries, makeSeries } from './testSeries'

vi.mock('@/charts/echarts', async () =>
  (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule(),
)

const SUMMARY = /^Network latency, last hour: p95 142 ms now/

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const apiWith = (getNetworkSeries: () => Promise<NetworkSeries>) =>
  createTestApi({ getNetworkSeries: vi.fn(getNetworkSeries) })

const overrides = registryOverrides()

beforeEach(() => {
  resetFakeCharts()
  vi.mocked(echarts.init).mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  overrides.restore()
})

describe('NetworkLatencyPanel', () => {
  it('is panel [2], a labelled region following the range, marked mock', async () => {
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    const region = screen.getByRole('region', { name: 'Network latency' })
    expect(region).toHaveAttribute('aria-keyshortcuts', '2')
    expect(region).not.toHaveAttribute('data-planned')
    expect(screen.getByText('1h')).toBeInTheDocument()
    expect(screen.getByText(/^mock/)).toBeInTheDocument()
    await screen.findByRole('figure')
  })

  it('takes its place in the Overview grid through className', async () => {
    renderApp(<NetworkLatencyPanel className="col-span-6" />, {
      api: apiWith(async () => makeSeries()),
    })
    expect(screen.getByRole('region', { name: 'Network latency' })).toHaveClass('col-span-6')
    await screen.findByRole('figure')
  })

  it('shows the figure with its summary, legend and an aggregation footer once data arrives', async () => {
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    const figure = await screen.findByRole('figure', { name: SUMMARY })
    expect(figure).toBeVisible()
    // The 150 ms threshold is labelled on the line itself: a legend key for it would only cost a row.
    expect(screen.getByRole('list', { name: 'Series' })).toHaveTextContent(
      'p95p50lossfailed probes',
    )
    expect(screen.getByText('p95 and p50 across 40 targets, loss = mean')).toBeInTheDocument()
    await waitFor(() => expect(echarts.init).toHaveBeenCalledTimes(1))
  })

  it('asks the API for the topbar range and scope', async () => {
    const api = apiWith(async () => makeSeries())
    renderApp(<NetworkLatencyPanel />, { api, route: '/?range=6h&customer=acme&site=athens' })
    await screen.findByRole('figure')
    expect(api.getNetworkSeries).toHaveBeenCalledWith({
      range: '6h',
      scope: { customerId: 'acme', siteId: 'athens' },
      signal: expect.any(AbortSignal),
    })
    expect(screen.getByText('6h')).toBeInTheDocument()
  })

  it('names the range in the summary and the table caption', async () => {
    renderApp(<NetworkLatencyPanel />, {
      api: apiWith(async () => makeSeries()),
      route: '/?range=24h',
    })
    expect(await screen.findByRole('figure', { name: /last 24 hours/ })).toBeVisible()
  })
})

describe('provenance', () => {
  const overHttp = () =>
    createTestApi({ getNetworkSeries: vi.fn(async () => makeSeries()), source: 'http' })
  const header = () =>
    screen.getByRole('region', { name: 'Network latency' }).querySelector('header') as HTMLElement

  it.each(DATA_FEATURES.filter((id) => id !== 'network'))(
    'stays mock over http when %s is connected and the network measurements are not',
    async (id) => {
      overrides.set(id, { backend: 'console-api', connected: true })
      renderApp(<NetworkLatencyPanel />, { api: overHttp() })
      await screen.findByRole('figure')
      expect(within(header()).getByText(/^mock/)).toBeInTheDocument()
      expect(within(header()).queryByText(/^live/)).toBeNull()
    },
  )

  it('stays mock over http while the console API does not serve the network measurements, connected or not', async () => {
    overrides.connectAll()
    overrides.set('network', { backend: 'stored', connected: true })
    renderApp(<NetworkLatencyPanel />, { api: overHttp() })
    await screen.findByRole('figure')
    expect(within(header()).getByText(/^mock/)).toBeInTheDocument()
  })

  it('reads live over http once the console API serves the network measurements and the screen reads them', async () => {
    overrides.connectAll()
    renderApp(<NetworkLatencyPanel />, { api: overHttp() })
    await screen.findByRole('figure')
    expect(within(header()).getByText(/^live/)).toBeInTheDocument()
    expect(within(header()).queryByText(/^mock/)).toBeNull()
  })

  it('stays mock under the mock adapter even when every feature is connected', async () => {
    overrides.connectAll()
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    await screen.findByRole('figure')
    expect(within(header()).getByText(/^mock/)).toBeInTheDocument()
  })
})

describe('loading', () => {
  it('keeps the frame, shows nothing for a fast load, then ghost axes after 150 ms', () => {
    vi.useFakeTimers()
    const { container } = renderApp(<NetworkLatencyPanel />, {
      api: apiWith(() => new Promise(() => {})),
    })
    const region = screen.getByRole('region', { name: 'Network latency' })
    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('.animate-skeleton')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(container.querySelector('.animate-skeleton')).not.toBeNull()
    expect(screen.queryByRole('figure')).toBeNull()
    // The footer names the aggregation even before the target count is known.
    expect(screen.getByText('p95 and p50 across targets, loss = mean')).toBeInTheDocument()
  })

  it('does not load the chart runtime until there is data to draw', async () => {
    const pending = deferred<NetworkSeries>()
    renderApp(<NetworkLatencyPanel />, { api: apiWith(() => pending.promise) })
    await act(async () => {})
    expect(echarts.init).not.toHaveBeenCalled()

    await act(async () => pending.resolve(makeSeries()))
    await screen.findByRole('figure')
    await waitFor(() => expect(echarts.init).toHaveBeenCalled())
  })

  it('keeps the shell free of the chart runtime: chart internals sit behind React.lazy', () => {
    const source = readFileSync(join(import.meta.dirname, 'NetworkLatencyPanel.tsx'), 'utf8')
    expect(source).toMatch(/lazy\(\(\) => import\('\.\/LatencyChart'\)\)/)
    expect(source).not.toMatch(/from '@\/charts\//)
    expect(source).not.toMatch(/from 'echarts/)
    expect(source).not.toMatch(/from '\.\/(LatencyChart|latencyOption)'/)
  })
})

describe('refetch', () => {
  function WithRangeSwitch() {
    const [, setRange] = useRange()
    return (
      <>
        <button onClick={() => setRange('6h')}>6h</button>
        <NetworkLatencyPanel />
      </>
    )
  }

  it('holds the previous render at reduced opacity while a new range loads, with no skeleton', async () => {
    const second = deferred<NetworkSeries>()
    const getNetworkSeries = vi
      .fn<() => Promise<NetworkSeries>>()
      .mockResolvedValueOnce(makeSeries())
      .mockReturnValueOnce(second.promise)
    const { container } = renderApp(<WithRangeSwitch />, {
      api: createTestApi({ getNetworkSeries }),
    })
    await screen.findByRole('figure', { name: SUMMARY })

    await userEvent.click(screen.getByRole('button', { name: '6h' }))
    await waitFor(() => expect(getNetworkSeries).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('figure', { name: SUMMARY })).toBeVisible()
    expect(screen.getByRole('figure').closest('.opacity-60')).not.toBeNull()
    expect(container.querySelector('.animate-skeleton')).toBeNull()

    await act(async () => second.resolve(makeSeries({ p95: [10, 20, 30, 40, 50] })))
    expect(await screen.findByRole('figure', { name: /last 6 hours: p95 50 ms now/ })).toBeVisible()
    expect(screen.getByRole('figure').closest('.opacity-60')).toBeNull()
  })
})

describe('error', () => {
  it('shows an inline error with Retry, and recovers when the retry succeeds', async () => {
    const getNetworkSeries = vi
      .fn<() => Promise<NetworkSeries>>()
      .mockRejectedValueOnce(new Error('upstream timeout'))
      .mockResolvedValueOnce(makeSeries())
    renderApp(<NetworkLatencyPanel />, { api: createTestApi({ getNetworkSeries }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load network latency')
    expect(screen.getByText('upstream timeout')).toBeInTheDocument()
    expect(screen.queryByRole('figure')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('figure', { name: SUMMARY })).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the last good chart under a non-blocking banner when a refresh fails', async () => {
    const getNetworkSeries = vi
      .fn<() => Promise<NetworkSeries>>()
      .mockResolvedValueOnce(makeSeries())
      .mockRejectedValueOnce(new Error('flaky'))
    renderApp(<NetworkLatencyPanel />, {
      api: createTestApi({ getNetworkSeries }),
      pollMs: 20,
    })
    await screen.findByRole('figure', { name: SUMMARY })
    expect(await screen.findByRole('status')).toHaveTextContent('Refresh failed')
    expect(screen.getByRole('figure', { name: SUMMARY })).toBeVisible()
  })
})

describe('empty', () => {
  it('says so, counts the enabled targets and links to Network, keeping the axes', async () => {
    const { container } = renderApp(<NetworkLatencyPanel />, {
      api: apiWith(async () => ({ ...makeEmptySeries(), targetCount: 40 })),
    })
    expect(await screen.findByText('No measurements in this range')).toBeVisible()
    expect(screen.getByText(/40 targets enabled/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open Network' })).toHaveAttribute('href', '/network')
    expect(container.querySelector('.border-t.border-border')).not.toBeNull()
    expect(screen.queryByRole('figure')).toBeNull()
    expect(echarts.init).not.toHaveBeenCalled()
  })

  it('counts a single target in the singular', async () => {
    renderApp(<NetworkLatencyPanel />, {
      api: apiWith(async () => ({ ...makeEmptySeries(), targetCount: 1 })),
    })
    expect(await screen.findByText(/1 target enabled/)).toBeVisible()
  })

  it('treats buckets in which no probe ran as empty too', async () => {
    renderApp(<NetworkLatencyPanel />, {
      api: apiWith(async () => makeSeries({ probeCount: [0, 0, 0, 0, 0] })),
    })
    expect(await screen.findByText('No measurements in this range')).toBeVisible()
  })
})

describe('keyboard and table', () => {
  it('toggles to the table twin with v while the panel has focus', async () => {
    const user = userEvent.setup()
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    await screen.findByRole('figure')
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())

    act(() => screen.getByRole('region', { name: 'Network latency' }).focus())
    await user.keyboard('v')
    expect(
      screen.getByRole('table', { name: 'Network latency and loss, last hour, newest first' }),
    ).toBeVisible()
    await user.keyboard('v')
    expect(screen.getByRole('slider', { name: 'Latency and loss cursor' })).toBeVisible()
  })

  it('moves the crosshair with the arrow keys and reads each sample aloud', async () => {
    const user = userEvent.setup()
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    const plot = await screen.findByRole('slider', { name: 'Latency and loss cursor' })
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
    act(() => plot.focus())

    expect(plot).toHaveAttribute(
      'aria-valuetext',
      '13:42 UTC, p95 142 ms, p50 70 ms, loss 2.1 percent, 0.1 percent over warn, failed probes 0 of 40',
    )
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(plot).toHaveAttribute(
      'aria-valuetext',
      '13:40 UTC, p95 no data, p50 no data, loss no data, failed probes 2 of 38',
    )
    expect(fakeCharts[0]?.dispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      x: expect.any(Number),
      y: 72,
    })
  })
})

describe('spikes', () => {
  it('says in the spoken sample how far a value is over its limit', async () => {
    const user = userEvent.setup()
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    const plot = await screen.findByRole('slider', { name: 'Latency and loss cursor' })
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
    act(() => plot.focus())

    await user.keyboard('{Home}{ArrowRight}')
    expect(plot).toHaveAttribute(
      'aria-valuetext',
      '13:39 UTC, p95 212 ms, 62 ms over warn, p50 90 ms, loss 0.5 percent, failed probes 0 of 40',
    )
  })

  it('names the samples over the limit and the worst one in the figure summary', async () => {
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    expect(
      await screen.findByRole('figure', {
        name: /1 sample over warn 150 ms \(UI default\), worst 212 ms at 13:39 UTC/,
      }),
    ).toBeVisible()
  })

  it('adds the flags column to the table twin', async () => {
    const user = userEvent.setup()
    renderApp(<NetworkLatencyPanel />, { api: apiWith(async () => makeSeries()) })
    await screen.findByRole('figure')
    await user.click(screen.getByRole('button', { name: /table/i }))
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Flags' })).toBeVisible()
    expect(within(table).getByRole('cell', { name: 'p95 62 ms over warn' })).toBeVisible()
  })
})

describe('with the mock API', () => {
  const NOW = Date.parse('2026-10-12T14:05:12Z')
  const mock = () => createMockApi({ now: () => NOW, delayMs: 0 })

  it('stays marked mock, and its summary says where the story goes over the latency limit', async () => {
    renderApp(<NetworkLatencyPanel />, { api: mock() })
    const figure = await screen.findByRole('figure', { name: /^Network latency, last hour/ })
    expect(figure).toHaveAccessibleName(
      /\d+ samples over warn 150 ms \(UI default\), worst \d+ ms at \d{2}:\d{2} UTC/,
    )
    expect(screen.getByText(/^mock/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Network latency' })).not.toHaveAttribute(
      'data-planned',
    )
  })

  it('draws a triangle on exactly the samples the summary counts, and labels the worst', async () => {
    const series = await mock().getNetworkSeries({ range: '1h' })
    renderApp(<NetworkLatencyPanel />, { api: mock() })
    await screen.findByRole('figure')
    await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())

    const option = fakeCharts[0]?.setOption.mock.calls.at(-1)?.[0] as {
      series: {
        id: string
        markPoint?: { data: { symbol?: string; label?: { show?: boolean } }[] }
      }[]
    }
    const p95 = option.series.find((s) => s.id === 'p95')
    const triangles = p95?.markPoint?.data.filter((mark) => mark.symbol === 'triangle') ?? []
    expect(spikeIndexes(series).length).toBeGreaterThan(0)
    expect(triangles).toHaveLength(spikeIndexes(series).length)
    expect(triangles.filter((mark) => mark.label?.show)).toHaveLength(1)
    expect(worstSpikeIndex(series)).toBeGreaterThanOrEqual(0)
    // Both limits are on the plot as series of their own.
    expect(option.series.map((s) => s.id)).toEqual(
      expect.arrayContaining(['reference:latency', 'reference:loss']),
    )
  })

  it('speaks the newest sample the way the model does, over-limit state included', async () => {
    const series = await mock().getNetworkSeries({ range: '1h' })
    renderApp(<NetworkLatencyPanel />, { api: mock() })
    const plot = await screen.findByRole('slider', { name: 'Latency and loss cursor' })
    expect(plot).toHaveAttribute(
      'aria-valuetext',
      describeSample(series, series.t.length - 1, 'utc'),
    )
    expect(plot.getAttribute('aria-valuetext')).toContain('over warn')
  })
})
