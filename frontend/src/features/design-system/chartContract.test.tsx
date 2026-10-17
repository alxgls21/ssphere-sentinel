import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSeries, TargetSeries } from '@/api/types'
import type { ChartOption } from '@/charts/echarts'
import { fakeCharts, resetFakeCharts } from '@/charts/testing/fakeEcharts'
import { isReferenceSeries } from '@/charts/testing/referenceSeries'
import { CHART_COLOR_TOKENS } from '@/charts/theme'
import LatencyChart from '@/features/overview/latency/LatencyChart'
import { makeSeries } from '@/features/overview/latency/testSeries'
import TargetHistoryChart from '@/features/network/TargetHistoryChart'
import { DeviceHistoryChart, InterfaceHistoryChart } from '@/features/snmp/HistoryCharts'
import { deviceSeries, interfaceSeries } from '@/features/snmp/testing'
import { DEFAULT_TARGET_LIMITS } from '@/lib/targets'
import ServerHistoryChart from '@/features/servers/ServerHistoryChart'
import { renderApp } from '@/test/render'
import BandwidthChart from './sample/BandwidthChart'
import { SAMPLE_BANDWIDTH } from './sample/bandwidth'

vi.mock('@/charts/echarts', async () =>
  (await import('@/charts/testing/fakeEcharts')).fakeEchartsModule(),
)

/**
 * The chart interaction contract (docs/design-system.md, "Chart interactions"),
 * run against every chart of the console. A chart that joins this list gets the
 * same checks; a chart that does not use ChartFrame and the shared time-series
 * pieces cannot pass them. Add the next chart here when it is built.
 */
interface ChartCase {
  name: string
  element: () => ReactElement
  /** Samples along the x axis. */
  count: number
  /** The toggleable series, by id, in legend order. */
  series: readonly string[]
  /** The static references (thresholds) drawn on the plot, by series id: no legend entry, never hidden. */
  references: readonly string[]
  cursorLabel: string
}

const HISTORY: ServerSeries = {
  generatedAt: '2026-10-12T14:00:00Z',
  bucketMs: 60_000,
  t: [0, 1, 2, 3, 4].map((minute) => Date.parse('2026-10-12T13:56:00Z') + minute * 60_000),
  cpu: [10, 20, 30, 40, 50],
  memory: [50, 51, 52, 53, 54],
  disk: [70, 70, 71, 71, 72],
}

const TARGET: TargetSeries = {
  generatedAt: '2026-10-12T14:00:00Z',
  bucketMs: 60_000,
  t: HISTORY.t,
  latencyMs: [10, 12, null, 11, 14],
  latencyMaxMs: [14, 18, null, 13, 20],
  lossPercent: [0, 1, null, 0, 3],
  measurements: [1, 1, 1, 1, 1],
  failed: [0, 0, 1, 0, 0],
}

const CHARTS: readonly ChartCase[] = [
  {
    name: 'network latency (two grids)',
    element: () => <LatencyChart series={makeSeries()} range="1h" />,
    count: makeSeries().t.length,
    series: ['p95', 'p50', 'loss', 'failed'],
    references: ['reference:latency', 'reference:loss'],
    cursorLabel: 'Latency and loss cursor',
  },
  {
    name: 'interface traffic (one grid)',
    element: () => <BandwidthChart />,
    count: SAMPLE_BANDWIDTH.t.length,
    series: ['in', 'out'],
    references: [],
    cursorLabel: 'Bandwidth cursor',
  },
  {
    name: 'server resource history (three grids)',
    element: () => <ServerHistoryChart name="ath-db-01" series={HISTORY} range="1h" />,
    count: HISTORY.t.length,
    series: ['cpu', 'memory', 'disk'],
    references: [],
    cursorLabel: 'Resource history cursor',
  },
  {
    name: 'network target history (three grids)',
    element: () => (
      <TargetHistoryChart
        name="ath-gateway"
        protocol="icmp"
        series={TARGET}
        range="1h"
        limits={DEFAULT_TARGET_LIMITS}
      />
    ),
    count: TARGET.t.length,
    series: ['latency', 'latencyMax', 'loss', 'failed'],
    references: ['reference:latency-warn', 'reference:loss-warn'],
    cursorLabel: 'Target history cursor',
  },
  {
    name: 'device poll history (three grids)',
    element: () => <DeviceHistoryChart name="ath-core-sw" series={deviceSeries()} range="1h" />,
    count: deviceSeries().t.length,
    series: ['response', 'reachable', 'failed'],
    references: [],
    cursorLabel: 'Device history cursor',
  },
  {
    name: 'interface traffic history (three grids)',
    element: () => <InterfaceHistoryChart name="Gi1/0/1" series={interfaceSeries()} range="1h" />,
    count: interfaceSeries().t.length,
    series: [
      'inBps',
      'outBps',
      'inBpsMax',
      'outBpsMax',
      'inErrorsPerSec',
      'outErrorsPerSec',
      'inDiscardsPerSec',
      'outDiscardsPerSec',
    ],
    references: [],
    cursorLabel: 'Interface history cursor',
  },
]

const root = document.documentElement

beforeEach(() => {
  resetFakeCharts()
  // Every token is a marker string, so a mark shows which token it is wired to.
  for (const [name, token] of Object.entries(CHART_COLOR_TOKENS))
    root.style.setProperty(token, `token:${name}`)
})
afterEach(() => {
  for (const token of Object.values(CHART_COLOR_TOKENS)) root.style.removeProperty(token)
})

const panel = (chart: ReactElement) =>
  renderApp(
    <section data-panel="2" aria-label="Panel" tabIndex={-1}>
      {chart}
    </section>,
  )

async function drawn() {
  await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
  return fakeCharts[0]!
}

/** The option the chart was last given. */
const optionOf = (chart: Awaited<ReturnType<typeof drawn>>) =>
  chart.setOption.mock.calls.at(-1)?.[0] as ChartOption

const allSeriesOf = (option: ChartOption) =>
  [option.series ?? []].flat() as { id: string; lineStyle?: { color?: string } }[]
/** The data series: what the legend toggles. */
const seriesOf = (option: ChartOption) => allSeriesOf(option).filter((s) => !isReferenceSeries(s))
const referencesOf = (option: ChartOption) =>
  allSeriesOf(option)
    .filter((s) => isReferenceSeries(s))
    .map((s) => s.id)
const axesOf = <T,>(axes: unknown): T[] => [axes ?? []].flat() as T[]

describe.each(CHARTS)('chart contract: $name', (chart) => {
  it('is a figure named by one sentence, with a legend, a table button and a keyboard cursor', async () => {
    panel(chart.element())
    expect(screen.getByRole('figure').getAttribute('aria-label')).toMatch(/\S+.*\S/)
    expect(screen.getByRole('list', { name: 'Series' })).toBeVisible()
    expect(screen.getByRole('button', { name: /table/i })).toBeVisible()
    expect(screen.getByRole('slider', { name: chart.cursorLabel })).toBeVisible()
    await drawn()
  })

  it('draws a plot that sizes in rem and fills what its panel gives it', async () => {
    panel(chart.element())
    const plot = screen.getByRole('slider')
    expect(plot.style.minHeight).toMatch(/rem$/)
    expect(plot).toHaveClass('flex-1')
    // The canvas fills the plot box by position, not by a percentage height, which collapses to 0
    // in a panel with no definite height (jsdom has no layout, so the class is the only guard).
    expect(plot.firstElementChild).toHaveClass('absolute', 'inset-0')
    await drawn()
  })

  it('moves one crosshair with the arrow keys over every sample and says each aloud', async () => {
    const user = userEvent.setup()
    panel(chart.element())
    const plot = screen.getByRole('slider', { name: chart.cursorLabel })
    const instance = await drawn()
    const last = chart.count - 1

    expect(plot).toHaveAttribute('aria-valuemin', '0')
    expect(plot).toHaveAttribute('aria-valuemax', String(last))
    // Rests on the newest sample.
    expect(plot).toHaveAttribute('aria-valuenow', String(last))

    act(() => plot.focus())
    expect(instance.dispatchAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'showTip' }),
    )
    await user.keyboard('{ArrowLeft}')
    expect(plot).toHaveAttribute('aria-valuenow', String(last - 1))
    await user.keyboard('{Home}')
    expect(plot).toHaveAttribute('aria-valuenow', '0')
    await user.keyboard('{ArrowLeft}')
    expect(plot).toHaveAttribute('aria-valuenow', '0')
    await user.keyboard('{End}{ArrowRight}')
    expect(plot).toHaveAttribute('aria-valuenow', String(last))
    expect(plot.getAttribute('aria-valuetext')).toMatch(/\S/)

    act(() => plot.blur())
    expect(instance.dispatchAction).toHaveBeenLastCalledWith({ type: 'hideTip' })
  })

  it('toggles every series from the legend, isolates on Shift-click, and never repaints the others', async () => {
    const user = userEvent.setup()
    panel(chart.element())
    const instance = await drawn()
    const [first, second] = chart.series as [string, string]
    const button = (id: string) =>
      within(screen.getByRole('list', { name: 'Series' })).getAllByRole('button')[
        chart.series.indexOf(id)
      ]!

    const before = seriesOf(optionOf(instance))
    expect(before.map((s) => s.id)).toEqual(chart.series)
    expect(chart.series.every((id) => button(id).getAttribute('aria-pressed') === 'true')).toBe(
      true,
    )

    await user.click(button(first))
    expect(button(first)).toHaveAttribute('aria-pressed', 'false')
    const hidden = seriesOf(optionOf(instance))
    expect(hidden.map((s) => s.id)).not.toContain(first)
    // Color follows the entity, never its rank among the visible series.
    const colorOf = (all: typeof before, id: string) =>
      all.find((s) => s.id === id)?.lineStyle?.color
    expect(colorOf(hidden, second)).toBe(colorOf(before, second))

    // Show it again, then Shift-click isolates one series and a second Shift-click shows them all.
    await user.click(button(first))
    await user.keyboard('{Shift>}')
    await user.click(button(second))
    expect(seriesOf(optionOf(instance)).map((s) => s.id)).toEqual([second])
    await user.click(button(second))
    await user.keyboard('{/Shift}')
    expect(seriesOf(optionOf(instance)).map((s) => s.id)).toEqual(chart.series)
  })

  it('draws its static references as series of their own: on the plot whatever the legend hides, out of the legend', async () => {
    const user = userEvent.setup()
    panel(chart.element())
    const instance = await drawn()
    expect(referencesOf(optionOf(instance))).toEqual(chart.references)
    expect(
      within(screen.getByRole('list', { name: 'Series' })).getAllByRole('button'),
    ).toHaveLength(chart.series.length)

    // Isolating one series hides every other, and the references stay.
    const [first] = chart.series as [string]
    await user.keyboard('{Shift>}')
    await user.click(
      within(screen.getByRole('list', { name: 'Series' })).getAllByRole('button')[
        chart.series.indexOf(first)
      ]!,
    )
    await user.keyboard('{/Shift}')
    expect(seriesOf(optionOf(instance)).map((s) => s.id)).toEqual([first])
    expect(referencesOf(optionOf(instance))).toEqual(chart.references)
  })

  it('has a table twin with one row per sample, newest first, behind the button and the v key', async () => {
    const user = userEvent.setup()
    panel(chart.element())
    await drawn()

    await user.click(screen.getByRole('button', { name: /table/i }))
    const table = screen.getByRole('table')
    // Header row plus one row per sample.
    expect(within(table).getAllByRole('row')).toHaveLength(chart.count + 1)
    expect(screen.getByRole('button', { name: /table/i })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: /table/i }))
    expect(screen.getByRole('slider', { name: chart.cursorLabel })).toBeVisible()

    act(() => screen.getByRole('region', { name: 'Panel' }).focus())
    await user.keyboard('v')
    expect(screen.getByRole('table')).toBeVisible()
  })

  it('shares one crosshair and one tooltip across every grid, on a time axis that starts at zero', async () => {
    panel(chart.element())
    const option = optionOf(await drawn())

    const xAxes = axesOf<{ type: string; min?: number; max?: number }>(option.xAxis)
    expect(xAxes.length).toBeGreaterThan(0)
    expect(xAxes.every((axis) => axis.type === 'time')).toBe(true)
    // Every grid shares the one time scale: same extent.
    expect(new Set(xAxes.map((axis) => `${axis.min}:${axis.max}`)).size).toBe(1)
    // A magnitude is never truncated.
    expect(axesOf<{ min: number }>(option.yAxis).every((axis) => axis.min === 0)).toBe(true)

    expect(option.axisPointer).toEqual({ link: [{ xAxisIndex: 'all' }] })
    expect(option.useUTC).toBe(true)
    const tooltip = option.tooltip as unknown as {
      trigger: string
      formatter: (params: unknown) => HTMLElement | string
    }
    expect(tooltip.trigger).toBe('axis')
    const node = tooltip.formatter([{ dataIndex: 0 }]) as HTMLElement
    // One row for every series the legend shows.
    for (const label of within(screen.getByRole('list', { name: 'Series' }))
      .getAllByRole('button')
      .map((entry) => entry.textContent ?? '')) {
      expect(node.textContent).toContain(label)
    }
  })
})
