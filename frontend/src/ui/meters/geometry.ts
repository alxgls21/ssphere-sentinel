/** Sparkline canvas, in px at 1rem = 16px (the SVG scales with the root size). */
export const SPARK_WIDTH = 64
export const SPARK_HEIGHT = 24
/** The 8px end dot plus its 2px ring needs 5px of room on every side it can touch. */
const PAD_LEFT = 1
const PAD_RIGHT = 5
const PAD_Y = 5

export type Point = readonly [x: number, y: number]

const round = (value: number) => Math.round(value * 100) / 100

/** One tenth of a unit at most, no trailing zero: 98, 99.5. */
const plain = (value: number) => String(Math.round(value * 10) / 10)

const finiteOnly = (values: readonly number[]) => values.filter(Number.isFinite)

/**
 * Maps a series onto the sparkline canvas: oldest left, evenly spaced, values
 * clamped to the domain so one outlier cannot draw outside the box. Fewer
 * than two usable values draw no line (the caller shows "no history").
 */
export function sparklinePoints(
  values: readonly number[],
  domain: readonly [min: number, max: number],
): Point[] {
  const series = finiteOnly(values)
  if (series.length < 2) return []
  const [min, max] = domain
  const span = max - min
  const left = PAD_LEFT
  const right = SPARK_WIDTH - PAD_RIGHT
  const top = PAD_Y
  const bottom = SPARK_HEIGHT - PAD_Y
  return series.map((value, index) => {
    const ratio = span > 0 ? (Math.min(max, Math.max(min, value)) - min) / span : 0.5
    return [
      round(left + (index / (series.length - 1)) * (right - left)),
      round(bottom - ratio * (bottom - top)),
    ]
  })
}

/** "Success rate last hour: 98 to 100 percent, now 99": the figures behind the line, in words. */
export function describeSeries(label: string, values: readonly number[], unit: string): string {
  const series = finiteOnly(values)
  const now = series.at(-1)
  if (series.length < 2 || now === undefined) return `${label}: no history`
  const low = plain(Math.min(...series))
  const high = plain(Math.max(...series))
  return low === high
    ? `${label}: ${low} ${unit} throughout`
    : `${label}: ${low} to ${high} ${unit}, now ${plain(now)}`
}
