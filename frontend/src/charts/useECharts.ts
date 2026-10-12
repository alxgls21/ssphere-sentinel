import { useEffect, useRef, useState, type RefObject } from 'react'
import { echarts, type ChartInstance, type ChartOption } from './echarts'
import { isMotionReduced } from './motion'
import {
  CHART_THEME,
  buildChartTheme,
  readChartTokens,
  readRootFontSize,
  type ChartTokens,
} from './theme'

/** Under this container width (px) charts drop end labels and reclaim the space they reserved. */
export const COMPACT_WIDTH_PX = 320

/** What an option builder may depend on beyond its data. Read at (re)initialisation, never cached. */
export interface ChartEnv {
  tokens: ChartTokens
  compact: boolean
  /** The plot container's height in CSS px, so a builder can give the extra room to its main grid. */
  height: number
}

export interface UseEChartsResult {
  ref: RefObject<HTMLDivElement | null>
  /** The live instance; null until fonts have loaded and the chart is initialised. */
  chart: ChartInstance | null
}

/** Canvas text is measured once at init, so the face must be loaded first or labels are mis-sized. */
const FONT_PROBE = '11px JetBrains Mono'

function fontsReady(): Promise<void> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts
  if (!fonts?.load) return Promise.resolve()
  // A face that fails to load must not leave the chart blank: fall through and draw.
  return fonts.load(FONT_PROBE).then(
    () => undefined,
    () => undefined,
  )
}

/** The series ids of an option, in order: what a visible tooltip refers to by index. */
function seriesKey(option: ChartOption): string {
  return [option.series ?? []]
    .flat()
    .map((series) => String(series.id ?? series.name ?? ''))
    .join('|')
}

/**
 * Mounts an ECharts instance in the returned ref'd element and keeps it in
 * sync with the option `build` produces. Waits for the mono face before the
 * first measure, resizes with the container and re-initialises when the root
 * font size changes (wall mode), because canvas geometry and type are px.
 *
 * `build` receives the current design tokens, so a builder never caches
 * colors or sizes. Pass a stable (useCallback) function: a new identity
 * rebuilds and re-applies the option.
 */
export function useECharts(build: (env: ChartEnv) => ChartOption): UseEChartsResult {
  const ref = useRef<HTMLDivElement | null>(null)
  const [chart, setChart] = useState<ChartInstance | null>(null)
  const [fontsLoaded, setFontsLoaded] = useState(false)
  const [rootSize, setRootSize] = useState(() => readRootFontSize())
  const [compact, setCompact] = useState(false)
  const [height, setHeight] = useState(0)
  // Series ids of the option on screen, to notice when the series list changes.
  const appliedSeries = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    void fontsReady().then(() => {
      if (alive) setFontsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const element = ref.current
    if (!element || !fontsLoaded) return
    echarts.registerTheme(CHART_THEME, buildChartTheme(readChartTokens()))
    const instance = echarts.init(element, CHART_THEME, { renderer: 'canvas' })
    const measure = () => {
      setCompact(element.clientWidth > 0 && element.clientWidth < COMPACT_WIDTH_PX)
      setHeight(element.clientHeight)
      // The container is sized in rem, so a root font size change always reaches this observer.
      setRootSize(readRootFontSize())
    }
    const observer = new ResizeObserver(() => {
      instance.resize()
      measure()
    })
    observer.observe(element)
    measure()
    setChart(instance)
    return () => {
      observer.disconnect()
      instance.dispose()
      appliedSeries.current = null
      setChart(null)
    }
    // `rootSize` is not read inside the effect: a change re-initialises the chart on purpose.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [fontsLoaded, rootSize])

  useEffect(() => {
    if (!chart) return
    const option = build({ tokens: readChartTokens(), compact, height })
    // A visible tooltip points at series by index. Hide it before the list changes (a legend toggle),
    // or ECharts re-reads a series that is gone and throws.
    const key = seriesKey(option)
    if (appliedSeries.current !== null && appliedSeries.current !== key) {
      chart.dispatchAction({ type: 'hideTip' })
    }
    appliedSeries.current = key
    // Replace series so a changed series list never leaves stale lines behind.
    // `animation` is set per update too: the Display menu can switch motion off after the theme was built.
    chart.setOption({ ...option, animation: !isMotionReduced() }, { replaceMerge: ['series'] })
  }, [chart, build, compact, height])

  return { ref, chart }
}
