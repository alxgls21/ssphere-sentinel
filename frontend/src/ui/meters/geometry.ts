import { formatTime, timezoneLabel, type Timezone } from '@/lib/format'

/** Sparkline canvas, in px at 1rem = 16px (the SVG scales with the root size). */
export const SPARK_WIDTH = 64
export const SPARK_HEIGHT = 24
/** The 8px end dot plus its 2px ring needs 5px of room on every side it can touch. */
const PAD_LEFT = 1
const PAD_RIGHT = 5
const PAD_Y = 5
/** The newest bucket sits here: the time axis ends at the same x with or without a sample. */
const PLOT_RIGHT = SPARK_WIDTH - PAD_RIGHT
/** The "no samples" tail runs under the 0% level, so it can never be read as a value. */
export const TAIL_Y = SPARK_HEIGHT - 2

export type Point = readonly [x: number, y: number]

/** One bucket of a series: a number, or nothing where the bucket held no sample. */
export type Sample = number | null | undefined

const round = (value: number) => Math.round(value * 100) / 100

/** One tenth of a unit at most, no trailing zero: 98, 99.5. */
const plain = (value: number) => String(Math.round(value * 10) / 10)

const isSample = (value: Sample): value is number => value != null && Number.isFinite(value)

/**
 * Maps a series onto the sparkline canvas, one entry per value: oldest left, x
 * following the value's place in the series, so a gap keeps its width instead
 * of being closed. A missing sample is null and nothing is drawn for it. Values
 * are clamped to the domain so one outlier cannot draw outside the box. Fewer
 * than two samples give no points at all (the caller shows "no history").
 */
export function sparklinePoints(
  values: readonly Sample[],
  domain: readonly [min: number, max: number],
): (Point | null)[] {
  if (values.filter(isSample).length < 2) return []
  const [min, max] = domain
  const span = max - min
  const top = PAD_Y
  const bottom = SPARK_HEIGHT - PAD_Y
  return values.map((value, index) => {
    if (!isSample(value)) return null
    const ratio = span > 0 ? (Math.min(max, Math.max(min, value)) - min) / span : 0.5
    return [
      round(PAD_LEFT + (index / (values.length - 1)) * (PLOT_RIGHT - PAD_LEFT)),
      round(bottom - ratio * (bottom - top)),
    ]
  })
}

/** Unbroken stretches of samples, oldest first: a missing sample ends one run and the next sample starts another. */
export function sparklineRuns(points: readonly (Point | null)[]): Point[][] {
  const runs: Point[][] = []
  let open: Point[] | null = null
  for (const point of points) {
    if (!point) {
      open = null
      continue
    }
    if (!open) {
      open = []
      runs.push(open)
    }
    open.push(point)
  }
  return runs
}

/**
 * Where a series that ends on a gap (the host stopped reporting) goes quiet:
 * from its newest sample to the last bucket. Null when the newest bucket has a sample.
 */
export function trailingGap(
  points: readonly (Point | null)[],
): { from: Point; toX: number } | null {
  const newest = points.findLastIndex((point) => point !== null)
  const from = points[newest]
  return from && newest < points.length - 1 ? { from, toX: PLOT_RIGHT } : null
}

/** What the bucket times are written in, so the figures can say when. */
export interface SeriesClock {
  /** Start of each value's bucket, epoch ms, parallel to the values. */
  times: readonly number[]
  tz: Timezone
}

/**
 * The figures behind a line, in words, one per entry: the range of values and
 * the latest one, how many buckets held no sample and, when the series ends on
 * a gap, that it went quiet (and when, given the bucket times). With the times
 * it also names the period and spells out min, max and average. Null when
 * there are fewer than two samples to draw a trend from. A `stale` series is
 * no longer being refreshed, so its newest sample is the last received, not "now".
 */
export function seriesFigures(
  values: readonly Sample[],
  unit: string,
  clock?: SeriesClock,
  stale = false,
): string[] | null {
  const samples = values.filter(isSample)
  const latest = samples.at(-1)
  if (samples.length < 2 || latest === undefined) return null
  const total = values.length
  const missing = total - samples.length
  const newest = values.findLastIndex(isSample)
  const stopped = newest < total - 1
  const low = plain(Math.min(...samples))
  const high = plain(Math.max(...samples))
  const timed = clock && clock.times.length === total ? clock : undefined
  const at = (index: number) => timed && formatTime(timed.times[index] ?? 0, timed.tz, false)
  const latestWord = stopped || stale ? 'last' : 'now'

  const figures: string[] = []
  if (timed) figures.push(`${at(0)} to ${at(total - 1)} ${timezoneLabel(timed.tz)}`)
  if (low === high) {
    figures.push(`${low} ${unit} throughout`)
  } else if (timed) {
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    figures.push(
      `${latestWord} ${plain(latest)} ${unit}`,
      `min ${low} ${unit}`,
      `max ${high} ${unit}`,
      `average ${plain(mean)} ${unit}`,
    )
  } else {
    figures.push(`${low} to ${high} ${unit}`, `${latestWord} ${plain(latest)}`)
  }
  if (missing > 0) figures.push(`${missing} of ${total} samples missing`)
  else if (timed) figures.push('no samples missing')
  if (stopped) {
    figures.push(
      timed
        ? `no samples since ${at(newest + 1)} ${timezoneLabel(timed.tz)}`
        : `no samples in the last ${total - 1 - newest} of ${total}`,
    )
  }
  return figures
}

/** "Success rate last hour: 98 to 100 percent, now 99": the figures behind the line, in words. */
export function describeSeries(
  label: string,
  values: readonly Sample[],
  unit: string,
  clock?: SeriesClock,
  stale = false,
): string {
  const figures = seriesFigures(values, unit, clock, stale)
  return figures ? `${label}: ${figures.join(', ')}` : `${label}: no history`
}
