import type { ReferenceLabelPosition } from '@/charts/timeSeries'
import { LATENCY_WARN_MS, LOSS_WARN_PERCENT } from '@/lib/thresholds'
import { LATENCY_GEOMETRY } from './latencyGeometry'

/**
 * Where the labels and marks of the latency chart go so that none lands on
 * another. ECharts places a label from its anchor and the text it is given and
 * does not avoid anything, so the layout is worked out here from the same
 * samples the plot draws. All distances are base px at the 16px root; the
 * builder scales them with the root font size, like every other geometry.
 *
 * The builder is never told the width of the plot, so x positions are
 * fractions of the time axis and a label's extent is estimated against the
 * width of a narrow plot (a phone, or a half-width panel at 1440px).
 */

/**
 * The warning triangle over a sample past its limit: 8px. Over a loss column it
 * sits 7px above the column; over a p95 sample 10px above, which clears the
 * 5px end mark of the newest sample.
 */
export const TRIANGLE_PX = 8
export const LOSS_TRIANGLE_RISE_PX = 7
export const SPIKE_TRIANGLE_RISE_PX = 10
/** A triangle covers the span from its base to its tip above the sample. */
const nearPx = (rise: number) => rise - TRIANGLE_PX / 2
const farPx = (rise: number) => rise + TRIANGLE_PX / 2

/** The 12px value labels (the worst spike, the end of a line) and the 11px limit labels. */
export const VALUE_LABEL_FONT_PX = 12
export const LIMIT_LABEL_FONT_PX = 11
/** Line box of a label: its font size at 1.2. */
const lineBox = (fontPx: number) => fontPx * 1.2

/** Air between a worst-spike label and the triangle under it. */
export const SPIKE_LABEL_GAP_PX = 2
/** Air between a limit label and its line. */
const LIMIT_LABEL_GAP_PX = 2
/** The 8px end mark with its 2px ring. */
const END_MARK_RADIUS_PX = 5
/** Half the 2px width of a line. */
const LINE_HALF_PX = 1
/** Half the width of a loss column (6px at most). */
const COLUMN_HALF_PX = 3

/** JetBrains Mono advances 0.6em per character. */
export const textWidthPx = (text: string, fontPx: number) => text.length * fontPx * 0.6

/** The plot width the label extents are measured against: the narrowest plot the layout has to hold. */
const ASSUMED_PLOT_PX = 260
const fractionOf = (px: number) => px / ASSUMED_PLOT_PX

/**
 * Room a spike needs above its sample inside the latency grid: its triangle and
 * the worst-spike label above it, less the inset the grid already leaves at the top.
 */
export const SPIKE_HEADROOM_PX =
  farPx(SPIKE_TRIANGLE_RISE_PX) +
  SPIKE_LABEL_GAP_PX +
  lineBox(VALUE_LABEL_FONT_PX) -
  LATENCY_GEOMETRY.top

/**
 * The value the latency axis has to reach: the limit with room above it, the
 * largest p50, and the largest p95, raised when there is a worst spike so that
 * its triangle and label fit inside the grid.
 */
export function latencyAxisTarget(
  p95Max: number,
  p50Max: number,
  hasWorstSpike: boolean,
  gridPx: number,
): number {
  const room = hasWorstSpike ? (p95Max * gridPx) / (gridPx - SPIKE_HEADROOM_PX) : p95Max
  return Math.max(LATENCY_WARN_MS * 1.1, room, p50Max)
}

/** The loss axis always shows the limit with room above it for its label. */
export const LOSS_AXIS_FLOOR = LOSS_WARN_PERCENT * 1.1

/** What sits near a limit line: x as a fraction of the time axis, y in px above (+) or below (-) the line. */
export interface Occupant {
  from: number
  to: number
  low: number
  high: number
  /** A filled shape (a triangle, a column, a dot) hides text under it; a thin line only crosses it. */
  solid: boolean
}

const around = (
  at: number,
  halfPx: number,
  low: number,
  high: number,
  solid: boolean,
): Occupant => ({
  from: at - fractionOf(halfPx),
  to: at + fractionOf(halfPx),
  low,
  high,
  solid,
})

interface LatencyOccupantsInput {
  /** Each sample's place on the time axis, 0 to 1. */
  at: readonly number[]
  p95: readonly (number | null)[]
  p50: readonly (number | null)[]
  /** The latency axis maximum and the grid height. */
  axisMax: number
  gridPx: number
  /** The p95 samples the plot marks as spikes. */
  spikes: readonly number[]
  /** The worst spike, whose label sits above its triangle (-1: none). */
  worst: number
  worstText: string
  /** The last sample with a p95, which carries the end mark (-1: none). */
  last: number
}

/** Everything the latency grid draws near its limit line, for placing the label of that line. */
export function latencyOccupants(input: LatencyOccupantsInput): Occupant[] {
  const { at, axisMax, gridPx, worst, last } = input
  const above = (ms: number) => ((ms - LATENCY_WARN_MS) * gridPx) / axisMax
  const out: Occupant[] = []
  at.forEach((x, index) => {
    for (const values of [input.p95, input.p50]) {
      const value = values[index]
      if (value != null) {
        out.push(around(x, 0, above(value) - LINE_HALF_PX, above(value) + LINE_HALF_PX, false))
      }
    }
  })
  for (const index of input.spikes) {
    const x = at[index]
    const value = input.p95[index]
    if (x === undefined || value == null) continue
    const y = above(value)
    out.push(
      around(
        x,
        TRIANGLE_PX / 2,
        y + nearPx(SPIKE_TRIANGLE_RISE_PX),
        y + farPx(SPIKE_TRIANGLE_RISE_PX),
        true,
      ),
    )
  }
  const lastAt = at[last]
  const lastValue = input.p95[last]
  if (lastAt !== undefined && lastValue != null) {
    const y = above(lastValue)
    out.push(
      around(lastAt, END_MARK_RADIUS_PX, y - END_MARK_RADIUS_PX, y + END_MARK_RADIUS_PX, true),
    )
  }
  const worstAt = at[worst]
  const worstValue = input.p95[worst]
  if (worstAt !== undefined && worstValue != null) {
    const [from, to] = labelSpan(worstAt, worstAlign(worstAt, input.worstText), input.worstText)
    const y = above(worstValue) + farPx(SPIKE_TRIANGLE_RISE_PX) + SPIKE_LABEL_GAP_PX
    out.push({ from, to, low: y, high: y + lineBox(VALUE_LABEL_FONT_PX), solid: true })
  }
  return out
}

interface LossOccupantsInput {
  at: readonly number[]
  loss: readonly (number | null)[]
  axisMax: number
  gridPx: number
  /** The samples at or over the limit, which carry a triangle. */
  over: readonly number[]
}

/** Everything the loss grid draws near its limit line: the columns and the triangles over the flagged ones. */
export function lossOccupants({ at, loss, axisMax, gridPx, over }: LossOccupantsInput): Occupant[] {
  const above = (percent: number) => ((percent - LOSS_WARN_PERCENT) * gridPx) / axisMax
  const out: Occupant[] = []
  at.forEach((x, index) => {
    const value = loss[index]
    if (value != null) out.push(around(x, COLUMN_HALF_PX, -gridPx, above(value), true))
  })
  for (const index of over) {
    const x = at[index]
    const value = loss[index]
    if (x === undefined || value == null) continue
    out.push(
      around(
        x,
        TRIANGLE_PX / 2,
        above(value) + nearPx(LOSS_TRIANGLE_RISE_PX),
        above(value) + farPx(LOSS_TRIANGLE_RISE_PX),
        true,
      ),
    )
  }
  return out
}

type Candidate = { position: ReferenceLabelPosition; end: boolean; top: boolean }

/** In order of preference: the start of the line, above it, is where the eye begins reading. */
const CANDIDATES: readonly Candidate[] = [
  { position: 'insideStartTop', end: false, top: true },
  { position: 'insideStartBottom', end: false, top: false },
  { position: 'insideEndTop', end: true, top: true },
  { position: 'insideEndBottom', end: true, top: false },
]

/**
 * The corner of a limit line its label goes in: the one where the fewest filled
 * shapes, then the fewest line vertices, fall within the label's reach. The
 * label spans `widthPx` from its end of the line and stands `fontPx` tall on
 * one side of it.
 */
export function placeLimitLabel(
  occupants: readonly Occupant[],
  widthPx: number,
  fontPx = LIMIT_LABEL_FONT_PX,
): ReferenceLabelPosition {
  const span = Math.min(1, fractionOf(widthPx))
  const height = lineBox(fontPx)
  const scored = CANDIDATES.map((candidate) => {
    const [from, to] = candidate.end ? [1 - span, 1] : [0, span]
    const low = candidate.top ? LIMIT_LABEL_GAP_PX : -(LIMIT_LABEL_GAP_PX + height)
    const high = candidate.top ? LIMIT_LABEL_GAP_PX + height : -LIMIT_LABEL_GAP_PX
    const hit = occupants.filter(
      (occupant) =>
        occupant.to >= from && occupant.from <= to && occupant.low < high && occupant.high > low,
    )
    return {
      candidate,
      solid: hit.filter((o) => o.solid).length,
      thin: hit.filter((o) => !o.solid).length,
    }
  })
  // Array.sort is stable: equal scores keep the order of preference.
  scored.sort((a, b) => a.solid - b.solid || a.thin - b.thin)
  return scored[0]?.candidate.position ?? 'insideStartTop'
}

export type LabelAlign = 'left' | 'center' | 'right'

/**
 * How the worst-spike label aligns to its triangle so that it stays inside the
 * plot: centred where it fits, flush to the triangle's side near an edge.
 */
export function worstAlign(at: number, text: string): LabelAlign {
  const half = fractionOf(textWidthPx(text, VALUE_LABEL_FONT_PX)) / 2
  if (at < half) return 'left'
  return at > 1 - half ? 'right' : 'center'
}

/** The x range, as fractions of the time axis, a label at `at` covers. */
function labelSpan(at: number, align: LabelAlign, text: string): [number, number] {
  const width = fractionOf(textWidthPx(text, VALUE_LABEL_FONT_PX))
  if (align === 'left') return [at, at + width]
  if (align === 'right') return [at - width, at]
  return [at - width / 2, at + width / 2]
}

/** Where on the time axis (0 to 1) a sample sits. Empty extents place everything at the start. */
export function axisFractions(
  t: readonly number[],
  min: number | undefined,
  max: number | undefined,
) {
  const range = min === undefined || max === undefined ? 0 : max - min
  return t.map((time) => (range > 0 && min !== undefined ? (time - min) / range : 0))
}
