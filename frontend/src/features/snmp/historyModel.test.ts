import { describe, expect, it } from 'vitest'
import { CHART_COLOR_TOKENS, type ChartColors } from '@/charts/theme'
import {
  describeDeviceBucket,
  describeInterfaceBucket,
  deviceTable,
  deviceTooltip,
  deviceValues,
  hasDeviceHistory,
  hasInterfaceHistory,
  hasInterfaceValues,
  interfaceTable,
  interfaceTooltip,
  summarizeDevice,
  summarizeInterface,
} from './historyModel'
import { deviceSeries, interfaceSeries } from './testing'

const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors

describe('device history', () => {
  it('keeps null buckets null: a gap is never a zero or an interpolation', () => {
    expect(deviceValues(deviceSeries(), 'response')).toEqual([10, 180, null, null, 12, 11])
  })

  it('counts reachable and failed polls only where something was polled: no poll is not 0 failed', () => {
    const s = deviceSeries()
    expect(deviceValues(s, 'reachable')).toEqual([1, 1, null, 0, 1, 1])
    expect(deviceValues(s, 'failed')).toEqual([0, 0, null, 1, 0, 0])
  })

  it('has a history for any bucket with a poll, even a failed one, and none for a device never polled', () => {
    expect(hasDeviceHistory(deviceSeries())).toBe(true)
    expect(
      hasDeviceHistory(
        deviceSeries({ reachablePolls: [0, 0, 0, 0, 0, 0], failedPolls: [0, 0, 0, 1, 0, 0] }),
      ),
    ).toBe(true)
    expect(
      hasDeviceHistory(
        deviceSeries({ t: [], responseMs: [], reachablePolls: [], failedPolls: [] }),
      ),
    ).toBe(false)
    expect(hasDeviceHistory(deviceSeries({ reachablePolls: [0, 0, 0, 0, 0, 0] }))).toBe(true)
  })

  it('summarises the polls and says what a gap is', () => {
    const text = summarizeDevice('ath-core-sw', deviceSeries(), '1h')
    expect(text).toMatch(/^Poll history of ath-core-sw, last hour: 4 reachable polls, 1 failed/)
    expect(text).toMatch(/A gap is a bucket with no reachable poll/)
    expect(
      summarizeDevice(
        'x',
        deviceSeries({ reachablePolls: [0, 0, 0, 0, 0, 0], failedPolls: [0, 0, 0, 0, 0, 0] }),
        '15m',
      ),
    ).toMatch(/: no polls$/)
  })

  it('speaks a bucket in full, an unanswered one apart from an empty one', () => {
    const s = deviceSeries()
    expect(describeDeviceBucket(s, 1, 'utc')).toBe(
      '09:55 UTC, response time 180.0 milliseconds, 1 reachable, 0 failed',
    )
    expect(describeDeviceBucket(s, 3, 'utc')).toBe(
      '09:57 UTC, no response time, no reachable poll, 0 reachable, 1 failed',
    )
    expect(describeDeviceBucket(s, 2, 'utc')).toBe('09:56 UTC, no polls')
  })

  it('lists the visible series in the tooltip, failed as a count of the bucket’s polls', () => {
    const rows = deviceTooltip(deviceSeries(), 3, 'utc', new Set(), colors).rows
    expect(rows.map(({ label, value }) => [label, value])).toEqual([
      ['Response time (mean)', '—'],
      ['Reachable polls', '0 of 1'],
      ['Failed polls', '1 of 1'],
    ])
    const empty = deviceTooltip(deviceSeries(), 2, 'utc', new Set(['response']), colors).rows
    expect(empty.map((row) => row.value)).toEqual(['no polls', 'no polls'])
  })

  it('gives a table twin, newest first', () => {
    const table = deviceTable('ath-core-sw', deviceSeries(), '1h', 'utc')
    expect(table.columns.map((c) => c.label)).toEqual([
      'Time (UTC)',
      'Response time (mean)',
      'Reachable polls',
      'Failed polls',
    ])
    expect(table.rows).toHaveLength(6)
    expect(table.rows[0]?.cells).toEqual(['11 ms', '1 of 1', '0 of 1'])
    expect(table.rows.at(-3)?.cells).toEqual(['—', 'no polls', 'no polls'])
  })
})

describe('interface history', () => {
  it('has a history for any bucket with a sample, even an unusable one', () => {
    expect(hasInterfaceHistory(interfaceSeries())).toBe(true)
    const allEmpty = interfaceSeries({
      validSamples: [0, 0, 0, 0, 0, 0],
      invalidSamples: [0, 0, 0, 0, 0, 0],
    })
    expect(hasInterfaceHistory(allEmpty)).toBe(false)
  })

  it('knows when every sample was unusable: samples but no value to draw', () => {
    const none = interfaceSeries({
      inBps: [null, null, null, null, null, null],
      outBps: [null, null, null, null, null, null],
      inBpsMax: [null, null, null, null, null, null],
      outBpsMax: [null, null, null, null, null, null],
      inErrorsPerSec: [null, null, null, null, null, null],
      outErrorsPerSec: [null, null, null, null, null, null],
      inDiscardsPerSec: [null, null, null, null, null, null],
      outDiscardsPerSec: [null, null, null, null, null, null],
      validSamples: [0, 0, 0, 2, 0, 0],
      invalidSamples: [0, 0, 0, 2, 0, 0],
    })
    expect(hasInterfaceHistory(none)).toBe(true)
    expect(hasInterfaceValues(none)).toBe(false)
    expect(hasInterfaceValues(interfaceSeries())).toBe(true)
  })

  it('summarises the usable samples and those without a rate, and never calls them zero traffic', () => {
    const text = summarizeInterface('Gi1/0/1', interfaceSeries(), '6h')
    expect(text).toMatch(
      /^Traffic history of Gi1\/0\/1, last 6 hours: 4 usable samples, 2 without a rate/,
    )
    expect(text).toMatch(/never drawn as zero traffic/)
  })

  it('speaks a bucket in full: traffic, highest, errors, discards and the samples behind them', () => {
    expect(describeInterfaceBucket(interfaceSeries(), 1, 'utc')).toBe(
      '09:55 UTC, inbound 800.0 Mbps, outbound 90.0 Mbps, highest inbound 900.0 Mbps, highest outbound 120.0 Mbps, errors 0.20/s in, 0.00/s out, discards 0.00/s in, 0.00/s out, 1 usable, 0 without a rate',
    )
  })

  it('says a bucket of only unusable samples has none usable, and an empty one no samples', () => {
    const s = interfaceSeries()
    expect(describeInterfaceBucket(s, 3, 'utc')).toBe(
      '09:57 UTC, no usable sample: 2 without a rate',
    )
    expect(describeInterfaceBucket(s, 2, 'utc')).toBe('09:56 UTC, no samples')
  })

  it('lists the visible series with the bucket’s samples, a gap as a dash and a real zero as zero', () => {
    const rows = interfaceTooltip(interfaceSeries(), 0, 'utc', new Set(), colors).rows
    expect(rows.map(({ label, value }) => [label, value])).toEqual([
      ['Inbound (mean)', '400.0 Mbps'],
      ['Outbound (mean)', '80.0 Mbps'],
      ['Inbound (highest)', '500.0 Mbps'],
      ['Outbound (highest)', '100.0 Mbps'],
      ['Inbound errors/s', '0.00/s'],
      ['Outbound errors/s', '0.00/s'],
      ['Inbound discards/s', '0.00/s'],
      ['Outbound discards/s', '0.00/s'],
      ['Samples', '1 usable, 0 without a rate'],
    ])
    const gap = interfaceTooltip(
      interfaceSeries(),
      3,
      'utc',
      new Set(['inBpsMax', 'outBpsMax']),
      colors,
    ).rows
    expect(gap.at(0)?.value).toBe('—')
    expect(gap.at(-1)?.value).toBe('0 usable, 2 without a rate')
    expect(gap.some((row) => row.label === 'Inbound (highest)')).toBe(false)
  })

  it('gives a table twin, newest first, with a column for the samples without a rate', () => {
    const table = interfaceTable('Gi1/0/1', interfaceSeries(), '1h', 'utc')
    expect(table.columns.map((c) => c.label).slice(-3)).toEqual([
      'Outbound discards/s',
      'Usable samples',
      'Samples without a rate',
    ])
    expect(table.rows).toHaveLength(6)
    const unusable = table.rows.at(-4)
    expect(unusable?.cells.slice(0, 2)).toEqual(['—', '—'])
    expect(unusable?.cells.slice(-2)).toEqual(['0', '2'])
  })
})
