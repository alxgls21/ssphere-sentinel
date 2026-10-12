import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useMemo } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import { ChartFrame, type ChartNavigation } from './ChartFrame'
import type { LegendEntry } from './ChartLegend'
import type { ChartTableModel } from './ChartTable'
import type { ChartOption } from './echarts'
import { fakeCharts, resetFakeCharts } from './testing/fakeEcharts'
import { useSeriesVisibility } from './useSeriesVisibility'

vi.mock('./echarts', async () => (await import('./testing/fakeEcharts')).fakeEchartsModule())

const IDS = ['p95', 'loss'] as const

const LEGEND: readonly LegendEntry[] = [
  { id: 'p95', label: 'p95', shape: 'line', color: 'var(--color-primary)' },
  { id: 'loss', label: 'loss', shape: 'rect', color: 'var(--color-series-2)' },
  { id: 'warn', label: 'warn 150 ms', shape: 'line', color: 'var(--color-warning)', toggle: false },
]

const TABLE: ChartTableModel = {
  caption: 'Latency, newest first',
  columns: [
    { label: 'Time (UTC)' },
    { label: 'p95', numeric: true },
    { label: 'Loss', numeric: true },
  ],
  rows: [
    { key: '2', header: '13:42', cells: ['150 ms', '0.0%'] },
    { key: '1', header: '13:41', cells: ['142 ms', '2.1%'] },
  ],
}

const COUNT = 5

function Frame({
  withPoint = true,
  legend = LEGEND,
}: {
  withPoint?: boolean
  legend?: readonly LegendEntry[]
}) {
  const visibility = useSeriesVisibility(IDS)
  // The option records what is hidden, so the test can see the legend reach the chart.
  const build = useCallback(
    () => ({ hiddenSeries: [...visibility.hidden].sort() }) as unknown as ChartOption,
    [visibility.hidden],
  )
  const navigation = useMemo<ChartNavigation>(
    () => ({
      count: COUNT,
      pointAt: (_chart, index) => (withPoint ? [index * 10, 40] : null),
      describe: (index) => `sample ${index}`,
    }),
    [withPoint],
  )
  return (
    <ChartFrame
      summary="Latency, last hour: p95 150 ms now"
      cursorLabel="Latency cursor"
      build={build}
      legend={legend}
      visibility={visibility}
      table={TABLE}
      navigation={navigation}
      heightPx={222}
    />
  )
}

/** The panel region the v key listens on: Panel marks it with data-panel. */
function renderInPanel(frame = <Frame />) {
  return renderApp(
    <section data-panel="2" aria-label="Panel" tabIndex={-1}>
      {frame}
    </section>,
  )
}

async function readyChart() {
  await waitFor(() => expect(fakeCharts[0]?.setOption).toHaveBeenCalled())
  return fakeCharts[0]!
}

beforeEach(() => resetFakeCharts())

describe('ChartFrame', () => {
  it('is a figure named by its one-sentence summary, with the plot described for keyboards', async () => {
    renderInPanel()
    expect(screen.getByRole('figure', { name: 'Latency, last hour: p95 150 ms now' })).toBeVisible()
    expect(screen.getByRole('slider', { name: 'Latency cursor' })).toHaveAccessibleDescription(
      expect.stringContaining('Left and Right'),
    )
    await readyChart()
  })

  it('sizes the plot in rem so it scales with the root font size, as a floor it grows past', async () => {
    renderInPanel()
    const plot = screen.getByRole('slider')
    expect(plot.style.minHeight).toBe('13.875rem')
    // It fills what its panel gives it: a taller window shows more chart, not blank space.
    expect(plot).toHaveClass('flex-1')
    await readyChart()
  })
})

describe('legend', () => {
  it('is absent for a single series: the panel title names it', async () => {
    renderInPanel(<Frame legend={[LEGEND[0]!]} />)
    expect(screen.queryByRole('list', { name: 'Series' })).toBeNull()
    expect(screen.getByRole('button', { name: /table/i })).toBeVisible()
    await readyChart()
  })

  it('does not count a static reference as a series', async () => {
    renderInPanel(<Frame legend={[LEGEND[0]!, LEGEND[2]!]} />)
    expect(screen.queryByRole('list', { name: 'Series' })).toBeNull()
    await readyChart()
  })

  it('lists every series as a toggle button, and static references as plain keys', async () => {
    renderInPanel()
    const legend = screen.getByRole('list', { name: 'Series' })
    expect(within(legend).getByRole('button', { name: 'p95' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(legend).getByRole('button', { name: 'loss' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(legend).getByText('warn 150 ms')).toBeVisible()
    expect(within(legend).queryByRole('button', { name: 'warn 150 ms' })).toBeNull()
    await readyChart()
  })

  it('toggles a series off and on, and hands the hidden set to the chart', async () => {
    const user = userEvent.setup()
    renderInPanel()
    const chart = await readyChart()
    const p95 = screen.getByRole('button', { name: 'p95' })

    await user.click(p95)
    expect(p95).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() =>
      expect(chart.setOption).toHaveBeenLastCalledWith(
        expect.objectContaining({ hiddenSeries: ['p95'] }),
        expect.anything(),
      ),
    )

    await user.click(p95)
    expect(p95).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() =>
      expect(chart.setOption).toHaveBeenLastCalledWith(
        expect.objectContaining({ hiddenSeries: [] }),
        expect.anything(),
      ),
    )
  })

  it('isolates a series on Shift-click and restores all on a second Shift-click', async () => {
    const user = userEvent.setup()
    renderInPanel()
    await readyChart()
    const loss = screen.getByRole('button', { name: 'loss' })

    await user.keyboard('{Shift>}')
    await user.click(loss)
    expect(screen.getByRole('button', { name: 'p95' })).toHaveAttribute('aria-pressed', 'false')
    expect(loss).toHaveAttribute('aria-pressed', 'true')

    await user.click(loss)
    await user.keyboard('{/Shift}')
    expect(screen.getByRole('button', { name: 'p95' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows a hidden series by more than color: struck through as well as aria-pressed', async () => {
    const user = userEvent.setup()
    renderInPanel()
    await readyChart()
    await user.click(screen.getByRole('button', { name: 'p95' }))
    expect(screen.getByRole('button', { name: 'p95' })).toHaveClass('line-through')
  })
})

describe('table view twin', () => {
  it('is a real table with a caption and header scopes', async () => {
    const user = userEvent.setup()
    renderInPanel()
    await readyChart()
    await user.click(screen.getByRole('button', { name: /table/i }))

    const table = screen.getByRole('table', { name: 'Latency, newest first' })
    const columns = within(table).getAllByRole('columnheader')
    expect(columns.map((c) => c.textContent)).toEqual(['Time (UTC)', 'p95', 'Loss'])
    for (const column of columns) expect(column).toHaveAttribute('scope', 'col')
    const rowHeaders = within(table).getAllByRole('rowheader')
    expect(rowHeaders.map((h) => h.textContent)).toEqual(['13:42', '13:41'])
    for (const header of rowHeaders) expect(header).toHaveAttribute('scope', 'row')
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('13:41142 ms2.1%')
  })

  it('replaces the plot, keeps the legend, and is reachable by keyboard when it scrolls', async () => {
    const user = userEvent.setup()
    renderInPanel()
    const chart = await readyChart()
    const toggle = screen.getByRole('button', { name: /table/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(chart.dispose).toHaveBeenCalled()
    expect(screen.getByRole('list', { name: 'Series' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Table view' })).toHaveAttribute('tabindex', '0')

    await user.click(toggle)
    expect(screen.getByRole('slider')).toBeVisible()
  })

  it('toggles with v while the panel region has focus', async () => {
    const user = userEvent.setup()
    renderInPanel()
    await readyChart()
    act(() => screen.getByRole('region', { name: 'Panel' }).focus())

    await user.keyboard('v')
    expect(screen.getByRole('table')).toBeVisible()
    await user.keyboard('v')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('slider')).toBeVisible()
  })

  it('toggles with the physical V key on a Greek layout and with Caps Lock', async () => {
    renderInPanel()
    await readyChart()
    const region = screen.getByRole('region', { name: 'Panel' })
    act(() => region.focus())

    // Greek layout: the V key types an omega, but its code is still KeyV.
    fireEvent.keyDown(region, { key: 'ω', code: 'KeyV' })
    expect(screen.getByRole('table')).toBeVisible()
    // Caps Lock reports an upper-case V without Shift.
    fireEvent.keyDown(region, { key: 'V', code: 'KeyV' })
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('advertises the v shortcut on the visible button', async () => {
    renderInPanel()
    expect(screen.getByRole('button', { name: /table/i })).toHaveAttribute('aria-keyshortcuts', 'v')
    await readyChart()
  })

  it('ignores v when single-key shortcuts are off, but the button still works', async () => {
    window.localStorage.setItem('sentinel.prefs.v1', JSON.stringify({ singleKeyShortcuts: false }))
    const user = userEvent.setup()
    renderInPanel()
    await readyChart()
    expect(screen.getByRole('button', { name: /table/i })).not.toHaveAttribute('aria-keyshortcuts')

    act(() => screen.getByRole('region', { name: 'Panel' }).focus())
    await user.keyboard('v')
    expect(screen.queryByRole('table')).toBeNull()

    await user.click(screen.getByRole('button', { name: /table/i }))
    expect(screen.getByRole('table')).toBeVisible()
  })

  it('does not steal v from a text field', async () => {
    const user = userEvent.setup()
    renderApp(
      <section data-panel="2" aria-label="Panel" tabIndex={-1}>
        <label>
          filter
          <input />
        </label>
        <Frame />
      </section>,
    )
    await readyChart()
    await user.type(screen.getByRole('textbox'), 'vv')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('moves focus to the toggle when the focused plot is replaced, so it is never dropped', async () => {
    const user = userEvent.setup()
    renderInPanel()
    await readyChart()
    act(() => screen.getByRole('slider').focus())
    await user.keyboard('v')
    expect(screen.getByRole('button', { name: /table/i })).toHaveFocus()
  })
})

describe('keyboard cursor', () => {
  it('is a focusable slider over the samples, resting on the newest', async () => {
    renderInPanel()
    await readyChart()
    const plot = screen.getByRole('slider', { name: 'Latency cursor' })
    expect(plot).toHaveAttribute('tabindex', '0')
    expect(plot).toHaveAttribute('aria-valuemin', '0')
    expect(plot).toHaveAttribute('aria-valuemax', String(COUNT - 1))
    expect(plot).toHaveAttribute('aria-valuenow', String(COUNT - 1))
    expect(plot).toHaveAttribute('aria-valuetext', `sample ${COUNT - 1}`)
  })

  it('shows the tip at the newest sample on keyboard focus, and hides it on blur', async () => {
    const user = userEvent.setup()
    renderInPanel()
    const chart = await readyChart()
    // Tab order: the two legend toggles, the table button, then the plot.
    for (let stop = 0; stop < 4; stop += 1) await user.tab()
    expect(screen.getByRole('slider')).toHaveFocus()
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'showTip', x: 40, y: 40 })

    await user.tab()
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'hideTip' })
  })

  it('moves the crosshair with Left, Right, Home and End and clamps at both ends', async () => {
    const user = userEvent.setup()
    renderInPanel()
    const chart = await readyChart()
    const plot = screen.getByRole('slider')
    act(() => plot.focus())
    chart.dispatchAction.mockClear()

    await user.keyboard('{ArrowLeft}')
    expect(plot).toHaveAttribute('aria-valuenow', '3')
    expect(plot).toHaveAttribute('aria-valuetext', 'sample 3')
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'showTip', x: 30, y: 40 })

    await user.keyboard('{Home}')
    expect(plot).toHaveAttribute('aria-valuenow', '0')
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'showTip', x: 0, y: 40 })

    await user.keyboard('{ArrowLeft}')
    expect(plot).toHaveAttribute('aria-valuenow', '0')

    await user.keyboard('{ArrowRight}')
    expect(plot).toHaveAttribute('aria-valuenow', '1')
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'showTip', x: 10, y: 40 })

    await user.keyboard('{End}')
    expect(plot).toHaveAttribute('aria-valuenow', '4')
    await user.keyboard('{ArrowRight}')
    expect(plot).toHaveAttribute('aria-valuenow', '4')
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'showTip', x: 40, y: 40 })
  })

  it('leaves other keys and modified arrows alone', async () => {
    const user = userEvent.setup()
    renderInPanel()
    const chart = await readyChart()
    act(() => screen.getByRole('slider').focus())
    chart.dispatchAction.mockClear()

    await user.keyboard('a')
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    expect(chart.dispatchAction).not.toHaveBeenCalled()
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '4')
  })

  it('starts again from the newest sample after the plot loses focus', async () => {
    const user = userEvent.setup()
    renderInPanel()
    await readyChart()
    const plot = screen.getByRole('slider')
    act(() => plot.focus())
    await user.keyboard('{Home}')
    expect(plot).toHaveAttribute('aria-valuenow', '0')
    act(() => plot.blur())
    expect(plot).toHaveAttribute('aria-valuenow', '4')
  })

  it('still announces the sample when the chart cannot place the crosshair', async () => {
    const user = userEvent.setup()
    renderInPanel(<Frame withPoint={false} />)
    const chart = await readyChart()
    const plot = screen.getByRole('slider')
    act(() => plot.focus())
    chart.dispatchAction.mockClear()
    await user.keyboard('{ArrowLeft}')
    expect(plot).toHaveAttribute('aria-valuetext', 'sample 3')
    expect(chart.dispatchAction).not.toHaveBeenCalled()
  })
})
