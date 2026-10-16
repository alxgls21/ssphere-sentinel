import { describe, expect, it } from 'vitest'
import { CHART_COLOR_TOKENS, type ChartColors } from '@/charts/theme'
import {
  LATENCY_SERIES,
  LATENCY_WARN_LABEL,
  LOSS_WARN_LABEL,
  describeSample,
  hasMeasurements,
  isLossOver,
  isSpike,
  lastValueIndex,
  latencyTable,
  lossOverIndexes,
  overWarn,
  peakIndex,
  sampleAt,
  spikeIndexes,
  summarizeLatency,
  tooltipContent,
  worstSpikeIndex,
  worstSpikeText,
} from './latencyModel'
import { T0, makeEmptySeries, makeSeries } from './testSeries'

const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors

describe('summarizeLatency', () => {
  it('says what the chart shows now: latest p95, the samples over the limit and the worst, the latest loss', () => {
    expect(summarizeLatency(makeSeries(), '1h', 'utc')).toBe(
      'Network latency, last hour: p95 142 ms now, 1 sample over warn 150 ms (UI default), worst 212 ms at 13:39 UTC, loss 2.1 percent, 2 samples at or over warn 2% (UI default), 2 failed probes',
    )
  })

  it('counts the samples over the latency limit and names the worst one', () => {
    const series = makeSeries({ p95: [160, 212, null, 151, 142] })
    expect(summarizeLatency(series, '1h', 'utc')).toContain(
      'p95 142 ms now, 3 samples over warn 150 ms (UI default), worst 212 ms at 13:39 UTC',
    )
  })

  it('says that nothing is over the limit, and still gives the peak', () => {
    const series = makeSeries({ p95: [100, 148, null, 150, 142], lossMean: [0, 0.5, null, 1.9, 1] })
    expect(summarizeLatency(series, '1h', 'utc')).toBe(
      'Network latency, last hour: p95 142 ms now, peak 150 ms at 13:41 UTC, none over warn 150 ms (UI default), loss 1.0 percent, 2 failed probes',
    )
  })

  it('judges the limit as displayed: 150.4 ms reads as the limit, 150.5 ms as over it', () => {
    expect(summarizeLatency(makeSeries({ p95: [150.4, 100] }), '1h', 'utc')).toContain(
      'none over warn 150 ms',
    )
    expect(summarizeLatency(makeSeries({ p95: [150.5, 100] }), '1h', 'utc')).toContain(
      '1 sample over warn 150 ms',
    )
  })

  it('uses the newest measured value when the newest bucket has no data', () => {
    const series = makeSeries({
      p95: [100, 212, null, 150, null],
      lossMean: [0, 0.5, null, 2.5, null],
    })
    expect(summarizeLatency(series, '6h', 'utc')).toContain('p95 150 ms now')
    expect(summarizeLatency(series, '6h', 'utc')).toContain('loss 2.5 percent')
    expect(summarizeLatency(series, '6h', 'utc')).toContain('last 6 hours')
  })

  it('names the range in words', () => {
    expect(summarizeLatency(makeSeries(), '15m', 'utc')).toContain('last 15 minutes')
    expect(summarizeLatency(makeSeries(), '24h', 'utc')).toContain('last 24 hours')
  })

  it('stays honest when there is nothing to report', () => {
    const empty = makeSeries({
      p95: [null, null, null, null, null],
      lossMean: [null, null, null, null, null],
      failedProbes: [0, 0, 0, 0, 0],
    })
    expect(summarizeLatency(empty, '1h', 'utc')).toBe(
      'Network latency, last hour: no p95 measurements',
    )
  })

  it('still reports the failed probes the plot draws when no bucket has a p95', () => {
    const down = makeSeries({
      p95: [null, null, null, null, null],
      p50: [null, null, null, null, null],
      lossMean: [100, 100, 100, 100, 100],
      failedProbes: [3, 3, 3, 3, 3],
      probeCount: [3, 3, 3, 3, 3],
    })
    expect(summarizeLatency(down, '1h', 'utc')).toBe(
      'Network latency, last hour: no p95 measurements, loss 100.0 percent, 5 samples at or over warn 2% (UI default), 15 failed probes',
    )
  })

  it('reports only the failed probes when no bucket has a p95 or a loss figure', () => {
    const down = makeSeries({
      p95: [null, null, null, null, null],
      lossMean: [null, null, null, null, null],
      failedProbes: [3, 3, 3, 3, 3],
    })
    expect(summarizeLatency(down, '1h', 'utc')).toBe(
      'Network latency, last hour: no p95 measurements, 15 failed probes',
    )
  })

  it('omits the failed probe clause when there were none and uses the singular for one', () => {
    expect(
      summarizeLatency(makeSeries({ failedProbes: [0, 0, 0, 0, 0] }), '1h', 'utc'),
    ).not.toContain('failed')
    expect(summarizeLatency(makeSeries({ failedProbes: [0, 0, 1, 0, 0] }), '1h', 'utc')).toContain(
      '1 failed probe',
    )
  })

  it('reports the peak time in the active timezone', () => {
    const peak = T0 + 60_000
    const local = new Date(peak)
    const hh = String(local.getHours()).padStart(2, '0')
    const mm = String(local.getMinutes()).padStart(2, '0')
    expect(summarizeLatency(makeSeries(), '1h', 'local')).toContain(
      `worst 212 ms at ${hh}:${mm} local`,
    )
  })
})

describe('samples', () => {
  it('reads one bucket across the parallel arrays', () => {
    expect(sampleAt(makeSeries(), 1)).toEqual({
      t: T0 + 60_000,
      p95: 212,
      p50: 90,
      loss: 0.5,
      failed: 0,
      probes: 40,
    })
  })

  it('finds the newest sample with a value', () => {
    expect(lastValueIndex([1, null, 3, null])).toBe(2)
    expect(lastValueIndex([null, null])).toBe(-1)
  })

  it('knows when nothing was measured', () => {
    expect(hasMeasurements(makeSeries())).toBe(true)
    expect(hasMeasurements(makeEmptySeries())).toBe(false)
    expect(hasMeasurements(makeSeries({ probeCount: [0, 0, 0, 0, 0] }))).toBe(false)
  })
})

describe('tooltip rows', () => {
  it('lists every series at the sample, values first, with failed probes as N of M', () => {
    const { title, rows } = tooltipContent(makeSeries(), 4, 'utc', new Set(), colors)
    expect(title).toBe('13:42Z')
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['p95', '142 ms'],
      ['p50', '70 ms'],
      ['loss', '2.1%'],
      ['failed probes', '0 of 40'],
    ])
  })

  it('keys each row by the metric slot and the mark it is drawn with', () => {
    const { rows } = tooltipContent(makeSeries(), 4, 'utc', new Set(), colors)
    expect(rows.map((row) => [row.key, row.color])).toEqual([
      ['line', 'token:primary'],
      ['line', 'token:seriesOther'],
      ['rect', 'token:series2'],
      ['diamond', 'token:critical'],
    ])
  })

  it('says no data for a bucket without data instead of NaN or null, and flags nothing', () => {
    const { rows } = tooltipContent(makeSeries(), 2, 'utc', new Set(), colors)
    expect(rows.map((row) => row.value)).toEqual(['no data', 'no data', 'no data', '2 of 38'])
    expect(rows.some((row) => row.flag)).toBe(false)
  })

  it('drops rows for series the legend switched off, and keeps the others in place', () => {
    const { rows } = tooltipContent(makeSeries(), 4, 'utc', new Set(['p50', 'failed']), colors)
    expect(rows.map((row) => row.label)).toEqual(['p95', 'loss'])
  })
})

describe('spoken sample', () => {
  it('reads the whole sample as one sentence for the keyboard cursor', () => {
    expect(describeSample(makeSeries(), 0, 'utc')).toBe(
      '13:38 UTC, p95 100 ms, p50 60 ms, loss 0.0 percent, failed probes 0 of 40',
    )
  })

  it('says how far a value is over its limit, right after the value', () => {
    expect(describeSample(makeSeries(), 1, 'utc')).toBe(
      '13:39 UTC, p95 212 ms, 62 ms over warn, p50 90 ms, loss 0.5 percent, failed probes 0 of 40',
    )
    expect(describeSample(makeSeries(), 4, 'utc')).toBe(
      '13:42 UTC, p95 142 ms, p50 70 ms, loss 2.1 percent, 0.1 percent over warn, failed probes 0 of 40',
    )
  })

  it('says no data for a missing measurement', () => {
    expect(describeSample(makeSeries(), 2, 'utc')).toBe(
      '13:40 UTC, p95 no data, p50 no data, loss no data, failed probes 2 of 38',
    )
  })
})

describe('table twin', () => {
  const table = latencyTable(makeSeries(), '1h', 'utc')

  it('has a caption that names the range and the order', () => {
    expect(table.caption).toBe('Network latency and loss, last hour, newest first')
  })

  it('has the columns time, p95, p50, loss, failed probes and flags', () => {
    expect(table.columns.map((column) => column.label)).toEqual([
      'Time (UTC)',
      'p95',
      'p50',
      'Loss',
      'Failed probes',
      'Flags',
    ])
    expect(table.columns.slice(1, 5).every((column) => column.numeric)).toBe(true)
    expect(table.columns[5]?.numeric).toBeUndefined()
  })

  it('lists one row per bucket, newest first', () => {
    expect(table.rows.map((row) => row.header)).toEqual([
      '13:42',
      '13:41',
      '13:40',
      '13:39',
      '13:38',
    ])
    expect(table.rows[0]?.cells).toEqual([
      '142 ms',
      '70 ms',
      '2.1%',
      '0 of 40',
      'loss 0.1% over warn',
    ])
    expect(table.rows[2]?.cells).toEqual(['no data', 'no data', 'no data', '2 of 38', 'none'])
  })

  it('says in the flags cell which values are over their limits, and none when nothing is', () => {
    const flags = table.rows.map((row) => row.cells[4])
    // Newest first: 13:42, 13:41, 13:40, 13:39, 13:38.
    expect(flags).toEqual([
      'loss 0.1% over warn',
      'loss 0.5% over warn',
      'none',
      'p95 62 ms over warn',
      'none',
    ])
  })

  it('gives every row a unique key', () => {
    expect(new Set(table.rows.map((row) => row.key)).size).toBe(table.rows.length)
  })

  it('covers every series the chart can draw, and the flags', () => {
    expect(table.columns).toHaveLength(LATENCY_SERIES.length + 2)
  })
})

describe('spikes', () => {
  it('judges a p95 sample against the limit as displayed: 150 and 150.4 read as the limit, 151 is over', () => {
    expect(isSpike(149)).toBe(false)
    expect(isSpike(150)).toBe(false)
    expect(isSpike(150.4)).toBe(false)
    expect(isSpike(150.5)).toBe(true)
    expect(isSpike(151)).toBe(true)
  })

  it('never calls a missing sample a spike', () => {
    expect(isSpike(null)).toBe(false)
    expect(isSpike(undefined)).toBe(false)
    expect(spikeIndexes(makeSeries({ p95: [null, null, null, null, null] }))).toEqual([])
  })

  it('lists the samples over the limit by index, ignoring gaps and values at the limit', () => {
    expect(spikeIndexes(makeSeries())).toEqual([1])
    expect(spikeIndexes(makeSeries({ p95: [150, 150.4, 151, null, 400] }))).toEqual([2, 4])
  })

  it('finds the peak sample, the first on a tie, and none when there are no values', () => {
    expect(peakIndex([100, 212, null, 150, 212])).toBe(1)
    expect(peakIndex([null, null])).toBe(-1)
  })

  it('names the worst spike only when the peak is over the limit', () => {
    expect(worstSpikeIndex(makeSeries())).toBe(1)
    expect(worstSpikeIndex(makeSeries({ p95: [100, 150, null, 120, 90] }))).toBe(-1)
    expect(worstSpikeIndex(makeSeries({ p95: [null, null, null, null, null] }))).toBe(-1)
  })

  it('labels the worst spike with its value and the time, in the active timezone', () => {
    expect(worstSpikeText(makeSeries(), 1, 'utc')).toBe('212 ms at 13:39Z')
    expect(worstSpikeText(makeSeries({ p95: [100, 1234, null, 150, 142] }), 1, 'utc')).toBe(
      '1.23 s at 13:39Z',
    )
    expect(worstSpikeText(makeSeries(), 1, 'local')).not.toContain('Z')
  })

  it('judges loss as displayed too: 1.96 reads 2.0 and is at the limit, 1.94 reads 1.9 and is not', () => {
    expect(isLossOver(1.94)).toBe(false)
    expect(isLossOver(1.96)).toBe(true)
    expect(isLossOver(2)).toBe(true)
    expect(isLossOver(null)).toBe(false)
    expect(lossOverIndexes(makeSeries())).toEqual([3, 4])
  })
})

describe('over warn', () => {
  it('says how many ms a p95 sample is over, from the displayed value', () => {
    expect(overWarn('p95', 212)).toBe('62 ms over warn')
    expect(overWarn('p95', 150.5)).toBe('1 ms over warn')
    expect(overWarn('p95', 211.6)).toBe('62 ms over warn')
  })

  it('says nothing within the limit or without data', () => {
    expect(overWarn('p95', 150)).toBeNull()
    expect(overWarn('p95', 150.4)).toBeNull()
    expect(overWarn('p95', null)).toBeNull()
    expect(overWarn('loss', 1.94)).toBeNull()
    expect(overWarn('loss', null)).toBeNull()
  })

  it('writes an overage of a second or more in seconds, like the value itself', () => {
    expect(overWarn('p95', 1234)).toBe('1.08 s over warn')
  })

  it('says how far loss is over, or that it is at the limit', () => {
    expect(overWarn('loss', 2.5)).toBe('0.5% over warn')
    expect(overWarn('loss', 2)).toBe('at warn')
    expect(overWarn('loss', 1.96)).toBe('at warn')
    expect(overWarn('loss', 12)).toBe('10.0% over warn')
  })

  it('writes the unit out for speech', () => {
    expect(overWarn('loss', 2.5, true)).toBe('0.5 percent over warn')
    expect(overWarn('p95', 212, true)).toBe('62 ms over warn')
  })

  it('names each limit the way the plot labels it', () => {
    expect(LATENCY_WARN_LABEL).toBe('warn 150 ms (UI default)')
    expect(LOSS_WARN_LABEL).toBe('warn 2% (UI default)')
  })
})

describe('flagged samples', () => {
  const series = makeSeries({ p95: [100, 212, null, 151, 142], lossMean: [0, 2, null, 2.5, 1.9] })

  it('puts the state in words on the tooltip row of a value over its limit, and only there', () => {
    const { rows } = tooltipContent(series, 1, 'utc', new Set(), colors)
    expect(rows.map((row) => [row.label, row.flag])).toEqual([
      ['p95', '62 ms over warn'],
      ['p50', undefined],
      ['loss', 'at warn'],
      ['failed probes', undefined],
    ])
  })

  it('drops the flag with the row when the legend hides the series', () => {
    const { rows } = tooltipContent(series, 1, 'utc', new Set(['p95']), colors)
    expect(rows.map((row) => row.label)).toEqual(['p50', 'loss', 'failed probes'])
    expect(rows.some((row) => row.flag?.includes('62 ms'))).toBe(false)
  })

  it('says the same thing in the tooltip, the spoken sample and the table for every sample', () => {
    const table = latencyTable(series, '1h', 'utc')
    series.t.forEach((_, index) => {
      const spoken = describeSample(series, index, 'utc')
      const { rows } = tooltipContent(series, index, 'utc', new Set(), colors)
      // The table lists the newest sample first.
      const flags = table.rows[series.t.length - 1 - index]?.cells[4] ?? ''
      const checks = [
        ['p95', 'p95', series.p95[index] ?? null],
        ['loss', 'loss', series.lossMean[index] ?? null],
      ] as const
      for (const [id, label, value] of checks) {
        const over = overWarn(id, value)
        const spokenOver = overWarn(id, value, true)
        expect(rows.find((row) => row.label === label)?.flag ?? null).toBe(over)
        expect(spoken.includes(`, ${spokenOver}`)).toBe(spokenOver !== null)
        expect(flags.includes(`${label} ${over}`)).toBe(over !== null)
      }
    })
  })

  it('counts in the summary exactly the samples the plot marks', () => {
    expect(spikeIndexes(series)).toHaveLength(2)
    expect(lossOverIndexes(series)).toHaveLength(2)
    expect(summarizeLatency(series, '1h', 'utc')).toContain('2 samples over warn 150 ms')
    expect(summarizeLatency(series, '1h', 'utc')).toContain('2 samples at or over warn 2%')
  })
})
