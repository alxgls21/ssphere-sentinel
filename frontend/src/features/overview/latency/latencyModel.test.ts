import { describe, expect, it } from 'vitest'
import { CHART_COLOR_TOKENS, type ChartColors } from '@/charts/theme'
import {
  LATENCY_SERIES,
  clockLabel,
  describeSample,
  hasMeasurements,
  lastValueIndex,
  latencyTable,
  sampleAt,
  summarizeLatency,
  tooltipContent,
} from './latencyModel'
import { T0, makeEmptySeries, makeSeries } from './testSeries'

const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors

describe('summarizeLatency', () => {
  it('says what the chart shows now: latest p95, the peak and when, and the latest loss', () => {
    expect(summarizeLatency(makeSeries(), '1h', 'utc')).toBe(
      'Network latency, last hour: p95 142 ms now, peak 212 ms at 13:39 UTC, loss 2.1 percent, 2 failed probes',
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
    const empty = makeSeries({ p95: [null, null, null, null, null] })
    expect(summarizeLatency(empty, '1h', 'utc')).toBe(
      'Network latency, last hour: no p95 measurements',
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
      `peak 212 ms at ${hh}:${mm} local`,
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

  it('marks UTC timestamps with Z and leaves local ones bare', () => {
    expect(clockLabel(T0, 'utc')).toBe('13:38Z')
    expect(clockLabel(T0, 'local')).not.toContain('Z')
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

  it('shows a dash for a bucket without data instead of NaN or null', () => {
    const { rows } = tooltipContent(makeSeries(), 2, 'utc', new Set(), colors)
    expect(rows.map((row) => row.value)).toEqual(['—', '—', '—', '2 of 38'])
  })

  it('drops rows for series the legend switched off, and keeps the others in place', () => {
    const { rows } = tooltipContent(makeSeries(), 4, 'utc', new Set(['p50', 'failed']), colors)
    expect(rows.map((row) => row.label)).toEqual(['p95', 'loss'])
  })
})

describe('spoken sample', () => {
  it('reads the whole sample as one sentence for the keyboard cursor', () => {
    expect(describeSample(makeSeries(), 4, 'utc')).toBe(
      '13:42 UTC, p95 142 ms, p50 70 ms, loss 2.1 percent, failed probes 0 of 40',
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

  it('has the columns time, p95, p50, loss and failed probes', () => {
    expect(table.columns.map((column) => column.label)).toEqual([
      'Time (UTC)',
      'p95',
      'p50',
      'Loss',
      'Failed probes',
    ])
    expect(table.columns.slice(1).every((column) => column.numeric)).toBe(true)
  })

  it('lists one row per bucket, newest first', () => {
    expect(table.rows.map((row) => row.header)).toEqual([
      '13:42',
      '13:41',
      '13:40',
      '13:39',
      '13:38',
    ])
    expect(table.rows[0]?.cells).toEqual(['142 ms', '70 ms', '2.1%', '0 of 40'])
    expect(table.rows[2]?.cells).toEqual(['—', '—', '—', '2 of 38'])
  })

  it('gives every row a unique key', () => {
    expect(new Set(table.rows.map((row) => row.key)).size).toBe(table.rows.length)
  })

  it('covers every series the chart can draw', () => {
    expect(table.columns).toHaveLength(LATENCY_SERIES.length + 1)
  })
})
