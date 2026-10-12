import { isMotionReduced } from './motion'

/**
 * The chart theme is derived at runtime from the design tokens
 * (src/styles/tokens.css): there is no second color definition. This works
 * because tokens are declared with `@theme static`, so every variable is
 * emitted to :root and readable through getComputedStyle.
 */

/** The 1rem the design is drawn at: geometry in px below is multiplied by rootSize / 16. */
export const BASE_ROOT_PX = 16

/** Registered theme name, passed to echarts.init. */
export const CHART_THEME = 'sentinel'

/**
 * The tokens a chart may use, by the name option builders refer to them with.
 * Status colors are here for threshold lines and failed-probe marks only:
 * health is otherwise rendered through StatusGlyph / StatusTag.
 */
export const CHART_COLOR_TOKENS = {
  panel: '--color-panel',
  raised: '--color-raised',
  border: '--color-border',
  borderStrong: '--color-border-strong',
  borderControl: '--color-border-control',
  grid: '--color-chart-grid',
  fg: '--color-fg',
  fgMuted: '--color-fg-muted',
  fgFaint: '--color-fg-faint',
  primary: '--color-primary',
  series2: '--color-series-2',
  series3: '--color-series-3',
  series4: '--color-series-4',
  seriesOther: '--color-series-other',
  warning: '--color-warning',
  critical: '--color-critical',
} as const

export type ChartColorName = keyof typeof CHART_COLOR_TOKENS
export type ChartColors = Record<ChartColorName, string>

/** Everything a chart needs from the design system, resolved at one moment. */
export interface ChartTokens {
  colors: ChartColors
  /** --font-mono: the one chart face. */
  fontFamily: string
  /** Root font size / 16. Canvas geometry and type are in px, so they scale with it (wall mode). */
  scale: number
}

/** The same color as a CSS value, for DOM parts of a chart (legend keys, tooltip swatches). */
export function cssColor(name: ChartColorName): string {
  return `var(${CHART_COLOR_TOKENS[name]})`
}

export function readRootFontSize(root: HTMLElement = document.documentElement): number {
  const size = Number.parseFloat(getComputedStyle(root).fontSize)
  return Number.isFinite(size) && size > 0 ? size : BASE_ROOT_PX
}

export function readChartTokens(root: HTMLElement = document.documentElement): ChartTokens {
  const style = getComputedStyle(root)
  const read = (name: string) => style.getPropertyValue(name).trim()
  const colors = Object.fromEntries(
    Object.entries(CHART_COLOR_TOKENS).map(([name, token]) => [name, read(token)]),
  ) as ChartColors
  return {
    colors,
    fontFamily: read('--font-mono'),
    scale: readRootFontSize(root) / BASE_ROOT_PX,
  }
}

/** Decals (45 and 135 degree texture on bars) are opt-in: only where hue is not dependable. */
export function needsDecals(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return (
    window.matchMedia('(forced-colors: active)').matches ||
    window.matchMedia('(prefers-contrast: more)').matches
  )
}

/** Fixed series slots, in order. Color follows the entity, never its rank. */
const SERIES_COLOR_ORDER = ['primary', 'series2', 'series3', 'series4', 'seriesOther'] as const

export interface ChartTheme {
  color: string[]
  backgroundColor: string
  textStyle: { fontFamily: string; fontSize: number; color: string }
  animation: boolean
  animationDuration: number
  animationDurationUpdate: number
  animationEasing: string
  animationEasingUpdate: string
  aria: { enabled: boolean; label: { enabled: boolean }; decal: { show: boolean } }
  categoryAxis: ThemeAxis
  timeAxis: ThemeAxis
  valueAxis: ThemeAxis
  tooltip: Record<string, unknown>
}

interface ThemeAxis {
  axisLine: { show: boolean; lineStyle: { color: string; width: number } }
  axisTick: { show: boolean }
  axisLabel: {
    color: string
    fontFamily: string
    fontSize: number
    margin: number
    hideOverlap: boolean
    verticalAlignMinLabel?: 'top' | 'middle' | 'bottom'
    verticalAlignMaxLabel?: 'top' | 'middle' | 'bottom'
  }
  splitLine: { show: boolean; lineStyle: { color: string; width: number; type: 'solid' } }
}

/**
 * The ECharts theme: transparent surface (the panel is the surface), 11px mono
 * fg-faint text, hairline solid horizontal gridlines only, no ticks, the DOM
 * tooltip chrome, and 400/300 ms cubicOut motion that is off under reduced motion.
 */
export function buildChartTheme(tokens: ChartTokens = readChartTokens()): ChartTheme {
  const { colors, fontFamily, scale } = tokens
  const px = (value: number) => value * scale

  const axis = (grid: boolean): ThemeAxis => ({
    // Horizontal gridlines only: the value axis draws them, the baseline is the time axis line.
    axisLine: { show: !grid, lineStyle: { color: colors.border, width: 1 } },
    axisTick: { show: false },
    axisLabel: {
      color: colors.fgFaint,
      fontFamily,
      fontSize: px(11),
      margin: px(8),
      // ECharts hides alternate labels instead of rotating or clipping them.
      hideOverlap: true,
      // Value-axis end labels sit inside the plot's vertical extent, so stacked grids never collide at their shared edge.
      ...(grid ? { verticalAlignMinLabel: 'bottom', verticalAlignMaxLabel: 'top' } : {}),
    },
    splitLine: { show: grid, lineStyle: { color: colors.grid, width: 1, type: 'solid' } },
  })

  return {
    color: SERIES_COLOR_ORDER.map((name) => colors[name]),
    backgroundColor: 'transparent',
    textStyle: { fontFamily, fontSize: px(11), color: colors.fgFaint },
    animation: !isMotionReduced(),
    animationDuration: 400,
    animationDurationUpdate: 300,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    // The frame owns the accessible name and value text; ECharts' generated
    // description would repeat it and mark the canvas as an image.
    aria: { enabled: true, label: { enabled: false }, decal: { show: needsDecals() } },
    categoryAxis: axis(false),
    timeAxis: axis(false),
    valueAxis: axis(true),
    tooltip: {
      backgroundColor: colors.raised,
      borderColor: colors.borderStrong,
      borderWidth: 1,
      borderRadius: 4,
      padding: px(8),
      textStyle: { color: colors.fg, fontFamily, fontSize: px(12) },
      // No shadow: the hairline border carries the edge.
      shadowBlur: 0,
      shadowColor: 'transparent',
      confine: true,
      transitionDuration: 0,
      hideDelay: 100,
      // The crosshair snaps to the nearest sample: readers aim at a time, not a pixel.
      axisPointer: {
        type: 'line',
        snap: true,
        lineStyle: { color: colors.borderControl, width: 1, type: 'solid' },
      },
    },
  }
}
