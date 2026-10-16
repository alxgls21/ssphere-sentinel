import { describe, expect, it } from 'vitest'
import { LATENCY_WARN_MS } from '@/lib/thresholds'
import {
  LOSS_AXIS_FLOOR,
  SPIKE_HEADROOM_PX,
  SPIKE_TRIANGLE_RISE_PX,
  TRIANGLE_PX,
  axisFractions,
  latencyAxisTarget,
  latencyOccupants,
  lossOccupants,
  placeLimitLabel,
  textWidthPx,
  worstAlign,
  type Occupant,
} from './latencyLayout'

/** The 24 characters of "warn 150 ms (UI default)" at 11px: about 158px, over half of a narrow plot. */
const LABEL_PX = textWidthPx('warn 150 ms (UI default)', 11)

const mark = (at: number, low: number, high: number, solid = true): Occupant => ({
  from: at,
  to: at,
  low,
  high,
  solid,
})

describe('textWidthPx', () => {
  it('advances 0.6em per character, as the mono face does', () => {
    expect(textWidthPx('abcdefghij', 10)).toBe(60)
    expect(LABEL_PX).toBeCloseTo(158.4)
  })
})

describe('axisFractions', () => {
  it('places each sample on the time axis between 0 and 1', () => {
    expect(axisFractions([100, 150, 200], 100, 200)).toEqual([0, 0.5, 1])
  })

  it('puts everything at the start when the axis has no extent', () => {
    expect(axisFractions([100, 200], undefined, undefined)).toEqual([0, 0])
    expect(axisFractions([100], 100, 100)).toEqual([0])
  })
})

describe('placeLimitLabel', () => {
  it('starts at the start of the line, above it, where nothing is in the way', () => {
    expect(placeLimitLabel([], LABEL_PX)).toBe('insideStartTop')
  })

  it('moves below the line when a filled mark sits in the band above it near the start', () => {
    // A triangle 4px to 12px above the line, 10% along the axis.
    expect(placeLimitLabel([mark(0.1, 4, 12)], LABEL_PX)).toBe('insideStartBottom')
  })

  it('moves to the other end when both bands at the start are taken', () => {
    expect(placeLimitLabel([mark(0.1, 4, 12), mark(0.1, -12, -4)], LABEL_PX)).toBe('insideEndTop')
  })

  it('ignores what is outside the label: a mark beyond its reach does not count', () => {
    // The label reaches about 61% along a 260px plot: a mark at 90% is clear of it at the start.
    expect(placeLimitLabel([mark(0.9, 4, 12)], LABEL_PX)).toBe('insideStartTop')
    // The same mark is under a label at the end, which then gives way to the start.
    expect(placeLimitLabel([mark(0.1, 4, 12), mark(0.9, 4, 12)], LABEL_PX)).toBe(
      'insideStartBottom',
    )
  })

  it('ignores what is far above or below the label band', () => {
    expect(placeLimitLabel([mark(0.1, 40, 48), mark(0.1, -60, -50)], LABEL_PX)).toBe(
      'insideStartTop',
    )
  })

  it('prefers a line vertex under the label to a filled mark over it', () => {
    const occupants = [mark(0.1, 4, 12, true), mark(0.1, -12, -4, false)]
    expect(placeLimitLabel(occupants, LABEL_PX)).toBe('insideEndTop')
    // With the far corners taken by filled marks too, the thin vertex is the lesser harm.
    const both = [...occupants, mark(0.9, 4, 12), mark(0.9, -12, -4)]
    expect(placeLimitLabel(both, LABEL_PX)).toBe('insideStartBottom')
  })

  it('takes the corner with the fewest filled marks when every corner is crowded', () => {
    const crowded = [mark(0.1, 4, 12), mark(0.2, 4, 12), mark(0.1, -12, -4), mark(0.9, 4, 12)]
    expect(placeLimitLabel(crowded, LABEL_PX)).toBe('insideEndBottom')
  })
})

describe('latencyOccupants', () => {
  const base = {
    at: [0.1, 0.5, 0.9],
    p95: [100, 200, 160] as (number | null)[],
    p50: [50, 60, 55] as (number | null)[],
    axisMax: 300,
    gridPx: 128,
    spikes: [1, 2],
    worst: 1,
    worstText: '200 ms at 13:39Z',
    last: 2,
  }
  const pxAbove = (ms: number) => ((ms - LATENCY_WARN_MS) * 128) / 300

  it('holds every line vertex as a thin occupant at its height over the limit line', () => {
    const thin = latencyOccupants(base).filter((o) => !o.solid)
    expect(thin).toHaveLength(6)
    const p95Mid = thin.find((o) => o.from === 0.5 && o.low < pxAbove(200) && o.high > pxAbove(200))
    expect(p95Mid).toBeDefined()
  })

  it('holds a filled triangle over each spike, from its base to its tip above the sample', () => {
    const half = TRIANGLE_PX / 2
    const triangle = latencyOccupants(base).find(
      (o) => o.solid && Math.abs(o.low - (pxAbove(200) + SPIKE_TRIANGLE_RISE_PX - half)) < 1e-9,
    )
    expect(triangle?.high).toBeCloseTo(pxAbove(200) + SPIKE_TRIANGLE_RISE_PX + half)
    expect(latencyOccupants(base).filter((o) => o.solid).length).toBe(4)
  })

  it('holds the worst label above the worst triangle, wide enough to span its text', () => {
    const label = latencyOccupants(base).find((o) => o.solid && o.to - o.from > 0.2)
    expect(label).toBeDefined()
    expect(label?.low).toBeGreaterThan(pxAbove(200) + SPIKE_TRIANGLE_RISE_PX + TRIANGLE_PX / 2)
  })

  it('holds nothing for samples without a value', () => {
    const gaps = latencyOccupants({
      ...base,
      p95: [null, null, null],
      p50: [null, null, null],
      spikes: [],
      worst: -1,
      last: -1,
    })
    expect(gaps).toEqual([])
  })
})

describe('lossOccupants', () => {
  const base = {
    at: [0.1, 0.5, 0.9],
    loss: [1, 3, null] as (number | null)[],
    axisMax: 4,
    gridPx: 48,
  }

  it('holds each column from the baseline up to its top, relative to the limit line', () => {
    const columns = lossOccupants({ ...base, over: [] })
    expect(columns).toHaveLength(2)
    // 2% is at 24px of 48; a column of 3% reaches 12px above the line, one of 1% sits 12px below it.
    expect(columns[1]?.high).toBeCloseTo(12)
    expect(columns[0]?.high).toBeCloseTo(-12)
    expect(columns.every((o) => o.solid && o.low === -48)).toBe(true)
  })

  it('holds a triangle over a flagged column', () => {
    const marked = lossOccupants({ ...base, over: [1] })
    expect(marked).toHaveLength(3)
    expect(marked[2]?.low).toBeCloseTo(12 + 3)
  })

  it('leaves a label above the line clear of the columns that stay under the limit', () => {
    const quiet = lossOccupants({ ...base, loss: [0.5, 1, 0.2], over: [] })
    expect(placeLimitLabel(quiet, textWidthPx('warn 2% (UI default)', 11))).toBe('insideStartTop')
  })
})

describe('worstAlign', () => {
  const text = '212 ms at 13:41Z'

  it('centres the label where it fits inside the plot', () => {
    expect(worstAlign(0.5, text)).toBe('center')
  })

  it('flushes it to its own side near an edge', () => {
    expect(worstAlign(0.02, text)).toBe('left')
    expect(worstAlign(0.98, text)).toBe('right')
  })
})

describe('latencyAxisTarget', () => {
  it('shows the limit with room above it when every value is low', () => {
    expect(latencyAxisTarget(60, 40, false, 128)).toBeCloseTo(LATENCY_WARN_MS * 1.1)
  })

  it('reaches the largest value when there is no spike label to make room for', () => {
    expect(latencyAxisTarget(212, 90, false, 128)).toBe(212)
    expect(latencyAxisTarget(60, 400, false, 128)).toBe(400)
  })

  it('raises the top by the room a spike triangle and its label need above the sample', () => {
    const target = latencyAxisTarget(212, 90, true, 128)
    expect(target).toBeGreaterThan(212)
    // At the target the worst sample sits exactly SPIKE_HEADROOM_PX below the grid top.
    expect(((target - 212) * 128) / target).toBeCloseTo(SPIKE_HEADROOM_PX)
  })

  it('leaves the loss axis a floor above the 2% limit', () => {
    expect(LOSS_AXIS_FLOOR).toBeGreaterThan(2)
  })
})
