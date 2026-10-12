import { formatTime, type Timezone } from '@/lib/format'
import type {
  ChartInstance,
  ChartOption,
  XAXisComponentOption,
  YAXisComponentOption,
} from './echarts'
import { buildTooltipElement, type TooltipContent } from './tooltip'

/**
 * The parts of a time-series option that every chart of the console shares, so
 * that two charts behave the same under the same mouse and keyboard: a time axis
 * with the same padding and clock, round value ticks from zero, one crosshair
 * across every grid, one tooltip, and a plot that grows with its panel. A chart
 * builds its own series and geometry and takes the rest from here.
 *
 * Pure: data in, an option fragment out, so the behavior is testable without a canvas.
 */

export interface NiceAxis {
  max: number
  interval: number
}

/**
 * The smallest 1-2-5 interval that covers `max` in at most `maxIntervals`
 * steps, so an axis always has a few round ticks starting at 0.
 */
export function niceAxis(max: number, maxIntervals: number): NiceAxis {
  for (let magnitude = 1; ; magnitude *= 10) {
    for (const step of [1, 2, 5]) {
      const interval = step * magnitude
      const steps = Math.ceil(max / interval)
      if (steps <= maxIntervals) return { max: Math.max(steps, 1) * interval, interval }
    }
  }
}

export interface TimeExtent {
  min?: number
  max?: number
}

/** Half a bucket of air on each side, so the first and last column are not cut by the plot edge. */
export function timeExtent(t: readonly number[], bucketMs: number): TimeExtent {
  const first = t[0]
  const last = t[t.length - 1]
  return first === undefined || last === undefined
    ? {}
    : { min: first - bucketMs / 2, max: last + bucketMs / 2 }
}

interface TimeAxisInput {
  gridIndex: number
  extent: TimeExtent
  tz: Timezone
  /** Only the bottom grid of a stack carries the clock: every grid shares the one time scale. */
  labelled: boolean
}

/** The shared x axis: wall-clock labels in the active timezone, HH:mm. */
export function timeAxis({ gridIndex, extent, tz, labelled }: TimeAxisInput): XAXisComponentOption {
  return {
    type: 'time',
    gridIndex,
    ...extent,
    splitNumber: 4,
    axisLabel: { show: labelled, formatter: (value: number) => formatTime(value, tz, false) },
  }
}

interface ValueAxisInput {
  gridIndex: number
  axis: NiceAxis
  format: (value: number) => string
}

/** A magnitude axis: always from zero, never truncated, with round ticks. */
export function valueAxis({ gridIndex, axis, format }: ValueAxisInput): YAXisComponentOption {
  return {
    type: 'value',
    gridIndex,
    min: 0,
    max: axis.max,
    interval: axis.interval,
    axisLabel: { formatter: format },
  }
}

interface CrosshairInput {
  tz: Timezone
  /** The tooltip for the sample the pointer or the keyboard cursor is on. */
  content: (dataIndex: number) => TooltipContent
}

/**
 * One crosshair across every grid and one tooltip listing every visible series
 * at the hovered x. The timezone is also what the time scale itself runs in.
 */
export function sharedCrosshair({
  tz,
  content,
}: CrosshairInput): Pick<ChartOption, 'useUTC' | 'axisPointer' | 'tooltip'> {
  return {
    useUTC: tz === 'utc',
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const hovered = Array.isArray(params) ? params[0] : params
        if (!hovered) return ''
        return buildTooltipElement(content(hovered.dataIndex))
      },
    },
  }
}

/**
 * Height in base px of the grid that takes the plot's spare room: whatever the
 * container has beyond the fixed parts of the stack, never less than `minPx`. With
 * no measurement yet it is that minimum. This is why a taller window shows more
 * chart instead of blank space.
 */
export function growingGridHeight(
  containerPx: number | undefined,
  scale: number,
  fixedPx: number,
  minPx: number,
): number {
  if (containerPx === undefined || containerPx <= 0 || scale <= 0) return minPx
  return Math.max(minPx, containerPx / scale - fixedPx)
}

/** The chart pixel x of the sample at `time`, or null while the chart cannot convert it. */
export function timeCursorX(chart: ChartInstance, time: number): number | null {
  const x = chart.convertToPixel({ xAxisIndex: 0 }, time)
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}
