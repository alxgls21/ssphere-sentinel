/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkSeries } from '@/api/types'
import { useRange } from '@/app/viewState'
import { echarts } from '@/charts/echarts'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
import { createTestApi, renderApp } from '@/test/render'
import { NetworkLatencyPanel } from './NetworkLatencyPanel'
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

beforeEach(() => {
  resetFakeCharts()
  vi.mocked(echarts.init).mockClear()
})
afterEach(() => vi.useRealTimers())

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
      '13:42 UTC, p95 142 ms, p50 70 ms, loss 2.1 percent, failed probes 0 of 40',
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
