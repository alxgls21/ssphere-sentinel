import { describe, expect, it } from 'vitest'
import { CHART_COLOR_TOKENS, type ChartColors } from '@/charts/theme'
import {
  describeSample,
  hasHistory,
  historySpecs,
  historyTable,
  lastBucketIndex,
  summarizeHistory,
  tooltipContent,
  valuesOf,
} from './targetHistoryModel'
import { series } from './testing'

const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors

describe('the series of a target', () => {
  it('names the loss series for what the protocol measures', () => {
    expect(historySpecs('icmp').find(({ id }) => id === 'loss')?.label).toBe('Packet loss')
    expect(historySpecs('tcp').find(({ id }) => id === 'loss')?.label).toBe(
      'Failed connection attempts',
    )
  })

  it('binds each series to its own colour and grid', () => {
    expect(historySpecs('icmp').map(({ id, color, grid }) => [id, color, grid])).toEqual([
      ['latency', 'primary', 0],
      ['latencyMax', 'series2', 0],
      ['loss', 'series3', 1],
      ['failed', 'critical', 2],
    ])
  })

  it('keeps null buckets null: a gap is never a zero or an interpolation', () => {
    const s = series()
    expect(valuesOf(s, 'latency')).toEqual([10, 180, null, null, 12, 11])
    expect(valuesOf(s, 'loss')).toEqual([0, 3.5, null, null, 0, 0])
  })

  it('counts failed measurements only where something was measured: no measurement is not 0 failed', () => {
    expect(valuesOf(series(), 'failed')).toEqual([0, 0, null, 1, 0, 0])
  })
})

describe('whether there is a history', () => {
  it('is any bucket that holds a measurement, even a failed one', () => {
    expect(hasHistory(series())).toBe(true)
    const onlyFailed = series({
      latencyMs: [null, null, null, null, null, null],
      latencyMaxMs: [null, null, null, null, null, null],
      lossPercent: [null, null, null, null, null, null],
      measurements: [0, 0, 0, 2, 0, 0],
      failed: [0, 0, 0, 2, 0, 0],
    })
    expect(hasHistory(onlyFailed)).toBe(true)
    expect(lastBucketIndex(onlyFailed)).toBe(3)
  })

  it('is none for a target never measured, or empty buckets', () => {
    expect(
      hasHistory(
        series({
          t: [],
          latencyMs: [],
          latencyMaxMs: [],
          lossPercent: [],
          measurements: [],
          failed: [],
        }),
      ),
    ).toBe(false)
    expect(
      hasHistory(series({ measurements: [0, 0, 0, 0, 0, 0], failed: [0, 0, 0, 0, 0, 0] })),
    ).toBe(false)
  })
})

describe('what it says', () => {
  it('summarises the measurements and the failures, and says what a gap is', () => {
    const text = summarizeHistory('ath-gateway', 'icmp', series(), '1h')
    expect(text).toMatch(
      /^Latency and packet loss history of ath-gateway, last hour: 5 measurements, 1 failed/,
    )
    expect(text).toMatch(/A gap is a bucket with no successful measurement/)
  })

  it('names the loss for a TCP target as failed connection attempts', () => {
    const text = summarizeHistory('api', 'tcp', series(), '6h')
    expect(text).toMatch(/failed connection attempts history of api, last 6 hours/)
    expect(text).not.toMatch(/packet/i)
  })

  it('says there are no measurements for an empty range', () => {
    const empty = series({ measurements: [0, 0, 0, 0, 0, 0], failed: [0, 0, 0, 0, 0, 0] })
    expect(summarizeHistory('x', 'icmp', empty, '15m')).toMatch(/: no measurements$/)
  })

  it('speaks a bucket in full, a gap as "no successful measurement" and an empty one as no measurements', () => {
    const s = series()
    expect(describeSample('icmp', s, 1, 'utc')).toBe(
      '09:55 UTC, latency mean 180.0 milliseconds, highest 260.0 milliseconds, packet loss 3.5 percent, 0 of 1 measurements failed',
    )
    expect(describeSample('icmp', s, 3, 'utc')).toMatch(
      /latency mean no successful measurement, highest no successful measurement, packet loss no value, 1 of 1 measurements failed$/,
    )
    expect(describeSample('icmp', s, 2, 'utc')).toBe('09:56 UTC, no measurements')
    expect(describeSample('tcp', s, 1, 'utc')).toMatch(/failed connection attempts 3.5 percent/)
  })

  it('lists the visible series in the tooltip, with failed as a count of the bucket’s measurements', () => {
    const rows = tooltipContent('icmp', series(), 3, 'utc', new Set(), colors).rows
    expect(rows.map(({ label, value, key }) => [label, value, key])).toEqual([
      ['Latency (mean)', '—', 'line'],
      ['Latency (highest)', '—', 'line'],
      ['Packet loss', '—', 'line'],
      ['Failed measurements', '1 of 1', 'rect'],
    ])
    const hidden = tooltipContent(
      'icmp',
      series(),
      1,
      'utc',
      new Set(['latencyMax', 'failed']),
      colors,
    )
    expect(hidden.rows.map((row) => row.label)).toEqual(['Latency (mean)', 'Packet loss'])
    expect(hidden.rows[0]?.value).toBe('180 ms')
    expect(hidden.rows[1]?.value).toBe('3.5%')
  })

  it('says "no measurements" for the failed count of a bucket nothing was measured in', () => {
    const rows = tooltipContent('icmp', series(), 2, 'utc', new Set(), colors).rows
    expect(rows.at(-1)?.value).toBe('no measurements')
  })

  it('gives a table twin, newest first, with every value and the measurement count', () => {
    const table = historyTable('ath-gateway', 'tcp', series(), '1h', 'utc')
    expect(table.caption).toBe('History of ath-gateway, last hour, newest first')
    expect(table.columns.map((column) => column.label)).toEqual([
      'Time (UTC)',
      'Latency (mean)',
      'Latency (highest)',
      'Failed connection attempts',
      'Failed measurements',
      'Measurements',
    ])
    expect(table.rows).toHaveLength(6)
    expect(table.rows[0]?.cells).toEqual(['11 ms', '13 ms', '0.0%', '0 of 1', '1'])
    expect(table.rows.at(-1)?.cells).toEqual(['10 ms', '14 ms', '0.0%', '0 of 1', '1'])
    expect(table.rows.at(-3)?.cells).toEqual(['—', '—', '—', 'no measurements', '0'])
  })
})
