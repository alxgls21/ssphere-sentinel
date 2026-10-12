import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { usePrefs } from '@/app/prefs'
import { cn } from '@/lib/cn'
import { BASE_ROOT_PX } from './theme'
import { ChartLegend, type LegendEntry } from './ChartLegend'
import { ChartTable, type ChartTableModel } from './ChartTable'
import type { ChartInstance, ChartOption } from './echarts'
import { useECharts, type ChartEnv } from './useECharts'
import type { SeriesVisibility } from './useSeriesVisibility'

/**
 * How a keyboard moves the crosshair through a chart. The frame owns the keys
 * and the slider semantics; the chart says where sample `index` is on screen.
 */
export interface ChartNavigation {
  /** Number of samples along the x axis. */
  count: number
  /** Chart pixel inside the plot for sample `index`, or null while the chart cannot answer. */
  pointAt: (chart: ChartInstance, index: number) => readonly [number, number] | null
  /** The sample as one spoken sentence (aria-valuetext). */
  describe: (index: number) => string
}

export interface ChartFrameProps {
  /** One sentence on what the chart shows now. It names the figure for assistive tech. */
  summary: string
  /** Name of the focusable plot, e.g. "Latency and loss cursor". */
  cursorLabel: string
  /** Builds the ECharts option from the design tokens. Memoize it: a new identity re-applies the option. */
  build: (env: ChartEnv) => ChartOption
  legend: readonly LegendEntry[]
  visibility: SeriesVisibility
  table: ChartTableModel
  navigation: ChartNavigation
  /**
   * Minimum plot height in px at the 16px root (it includes the x-axis band), rendered in rem. The
   * plot grows past it to fill the space its panel gives it, so a taller window shows more chart.
   */
  heightPx: number
  className?: string
}

type View = 'chart' | 'table'

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))

interface ChartPlotProps extends Pick<
  ChartFrameProps,
  'build' | 'navigation' | 'cursorLabel' | 'heightPx'
> {
  hintId: string
}

/** The canvas and its keyboard cursor, a slider over the samples: Left/Right/Home/End. */
function ChartPlot({ build, navigation, cursorLabel, heightPx, hintId }: ChartPlotProps) {
  const { ref, chart } = useECharts(build)
  const [active, setActive] = useState<number | null>(null)
  const last = navigation.count - 1
  // Rests on the newest sample, and stays valid when a refresh shortens the series.
  const index = active === null ? last : Math.min(active, last)

  const moveTo = useCallback(
    (next: number) => {
      setActive(next)
      const point = chart ? navigation.pointAt(chart, next) : null
      if (chart && point) chart.dispatchAction({ type: 'showTip', x: point[0], y: point[1] })
    },
    [chart, navigation],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (last < 0 || event.altKey || event.ctrlKey || event.metaKey) return
    let next: number
    switch (event.key) {
      case 'ArrowLeft':
        next = index - 1
        break
      case 'ArrowRight':
        next = index + 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    moveTo(Math.min(Math.max(next, 0), last))
  }

  return (
    <div
      // A native range input cannot be the plot surface: the canvas is the control, so it carries the slider role.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="slider"
      tabIndex={0}
      aria-label={cursorLabel}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(last, 0)}
      aria-valuenow={Math.max(index, 0)}
      aria-valuetext={last >= 0 ? navigation.describe(index) : undefined}
      aria-describedby={hintId}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (last >= 0) moveTo(index)
      }}
      onBlur={() => {
        setActive(null)
        chart?.dispatchAction({ type: 'hideTip' })
      }}
      style={{ minHeight: `${heightPx / BASE_ROOT_PX}rem` }}
      className="relative min-h-0 flex-1 rounded-sm"
    >
      {/* Absolute, not size-full: a percentage height collapses to 0 when the panel has no definite height. */}
      <div ref={ref} className="absolute inset-0" />
    </div>
  )
}

/**
 * Wrapper for every ECharts chart in the console: a figure named by a
 * one-sentence summary, an HTML legend, a keyboard-focusable plot, and a table
 * twin of the same values (a button, or the v key while the panel has focus).
 */
export function ChartFrame({
  summary,
  cursorLabel,
  build,
  legend,
  visibility,
  table,
  navigation,
  heightPx,
  className,
}: ChartFrameProps) {
  const { singleKeyShortcuts } = usePrefs()
  const [view, setView] = useState<View>('chart')
  const hintId = useId()
  const figureRef = useRef<HTMLElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  const switchView = useCallback(() => {
    // The view that holds focus is about to unmount: keep focus on a stable control instead of dropping it to the page.
    if (viewRef.current?.contains(document.activeElement)) toggleRef.current?.focus()
    setView((current) => (current === 'chart' ? 'table' : 'chart'))
  }, [])

  // v toggles the view while the panel holds focus. The listener sits on the
  // panel region (Panel marks it with data-panel), not on the figure, so it
  // works when the region itself is focused after the digit hotkey.
  useEffect(() => {
    if (!singleKeyShortcuts) return
    const region = figureRef.current?.closest<HTMLElement>('[data-panel]') ?? figureRef.current
    if (!region) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // The physical key, like the other panel shortcuts: it must work on Greek and Cyrillic
      // layouts (where the V key types another letter) and with Caps Lock.
      if (event.code !== 'KeyV' || event.shiftKey) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.defaultPrevented || isEditable(event.target)) return
      switchView()
    }
    region.addEventListener('keydown', onKeyDown)
    return () => region.removeEventListener('keydown', onKeyDown)
  }, [singleKeyShortcuts, switchView])

  return (
    <figure
      ref={figureRef}
      aria-label={summary}
      className={cn('flex h-full min-h-0 min-w-0 flex-col', className)}
    >
      <div className="flex min-h-6 items-center gap-3">
        {/* A single series needs no legend: the title names it. */}
        {legend.filter((entry) => entry.toggle !== false).length > 1 ? (
          <ChartLegend entries={legend} visibility={visibility} className="min-w-0 flex-1" />
        ) : (
          <span className="flex-1" />
        )}
        <button
          ref={toggleRef}
          type="button"
          aria-pressed={view === 'table'}
          aria-keyshortcuts={singleKeyShortcuts ? 'v' : undefined}
          onClick={switchView}
          className={cn(
            'type-tag inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm border border-border-control px-1.5 pointer-coarse:h-(--hit)',
            'transition-colors duration-(--dur-fast) hover:bg-hover aria-pressed:bg-primary-tint aria-pressed:text-primary',
            view === 'chart' && 'text-fg-muted hover:text-fg',
          )}
        >
          <kbd aria-hidden="true" className="type-kbd text-fg-faint">
            v
          </kbd>
          Table
        </button>
      </div>

      <div ref={viewRef} className="flex min-h-0 flex-1 flex-col">
        {view === 'chart' ? (
          <ChartPlot
            build={build}
            navigation={navigation}
            cursorLabel={cursorLabel}
            heightPx={heightPx}
            hintId={hintId}
          />
        ) : (
          <ChartTable table={table} heightRem={heightPx / BASE_ROOT_PX} />
        )}
      </div>

      <figcaption id={hintId} className="sr-only">
        Left and Right move the cursor through the samples, Home and End jump to the first and last.
        The table view lists every value.
      </figcaption>
    </figure>
  )
}
