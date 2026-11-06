import { describe, expect, it } from 'vitest'
import {
  EMPTY,
  formatAge,
  formatBitsPerSecond,
  formatBytes,
  formatClock,
  formatDuration,
  formatInteger,
  formatLatency,
  formatPercent,
  formatQuantity,
  formatStamp,
} from './format'

describe('format', () => {
  it('renders missing or invalid values as an em dash, never NaN or null', () => {
    for (const fn of [
      formatInteger,
      formatPercent,
      formatLatency,
      formatBytes,
      formatBitsPerSecond,
      formatDuration,
    ]) {
      expect(fn(null)).toBe(EMPTY)
      expect(fn(undefined)).toBe(EMPTY)
      expect(fn(Number.NaN)).toBe(EMPTY)
    }
    expect(formatAge(null, 0)).toBe(EMPTY)
    expect(formatAge('not a date', 0)).toBe(EMPTY)
  })

  it('formats percentages', () => {
    expect(formatPercent(91.04)).toBe('91%')
    expect(formatPercent(6, 1)).toBe('6.0%')
  })

  it('formats latency with sensible precision', () => {
    expect(formatLatency(0.84)).toBe('0.8 ms')
    expect(formatLatency(38.4)).toBe('38 ms')
    expect(formatLatency(1500)).toBe('1.50 s')
  })

  it('formats sizes in binary units and rates in decimal units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(32 * 1024 ** 3)).toBe('32.0 GiB')
    expect(formatBytes(-1)).toBe(EMPTY)
    expect(formatBitsPerSecond(950)).toBe('950 bps')
    expect(formatBitsPerSecond(410e6)).toBe('410.0 Mbps')
    expect(formatBitsPerSecond(1.2e9)).toBe('1.2 Gbps')
  })

  it('formats durations with the two most significant units', () => {
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(12 * 60 + 5)).toBe('12m 5s')
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3h 12m')
    expect(formatDuration(14 * 86_400 + 3 * 3600)).toBe('14d 3h')
  })

  it('formats ages relative to now, clamping the future', () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    expect(formatAge('2026-10-12T11:59:58Z', now)).toBe('now')
    expect(formatAge('2026-10-12T11:59:18Z', now)).toBe('42s')
    expect(formatAge('2026-10-12T11:46:00Z', now)).toBe('14m')
    expect(formatAge('2026-10-12T09:00:00Z', now)).toBe('3h')
    expect(formatAge('2026-10-10T12:00:00Z', now)).toBe('2d')
    expect(formatAge('2026-10-12T12:05:00Z', now)).toBe('now')
  })

  it('writes clock times with the Z of UTC, seconds by default', () => {
    const at = Date.parse('2026-10-12T15:32:07Z')
    expect(formatClock(at, 'utc')).toBe('15:32:07Z')
    expect(formatClock(at, 'utc', false)).toBe('15:32Z')
    expect(formatClock(at, 'local')).not.toMatch(/Z$/)
  })

  it('stamps a moment with its clock today, its weekday in the six days before, and its date before that', () => {
    const now = Date.parse('2026-11-06T15:00:00Z') // a Friday
    const stamp = (iso: string) => formatStamp(Date.parse(iso), 'utc', now)
    expect(stamp('2026-11-06T09:12:44Z')).toBe('09:12:44Z')
    expect(stamp('2026-11-06T00:00:00Z')).toBe('00:00:00Z')
    expect(stamp('2026-11-05T23:59:59Z')).toBe('Thu 23:59:59Z')
    expect(stamp('2026-10-31T09:00:00Z')).toBe('Sat 09:00:00Z')
    // A week back falls on today's weekday, so it is dated instead.
    expect(stamp('2026-10-30T09:00:00Z')).toBe('Oct 30 09:00:00Z')
    expect(stamp('2026-10-03T09:12:44Z')).toBe('Oct 3 09:12:44Z')
    expect(stamp('2025-12-31T09:00:00Z')).toBe('Dec 31 2025 09:00:00Z')
    // A later day than the clock it is judged by (a skewed clock) is dated, never given a weekday.
    expect(stamp('2026-11-07T01:00:00Z')).toBe('Nov 7 01:00:00Z')
  })

  it('decides what is today in the chosen timezone', () => {
    // Built from local fields, so these hold in whatever timezone the tests run.
    const now = new Date(2026, 10, 6, 15, 0, 0).getTime()
    expect(formatStamp(new Date(2026, 10, 6, 0, 30, 0).getTime(), 'local', now)).toBe('00:30:00')
    expect(formatStamp(new Date(2026, 10, 5, 23, 30, 0).getTime(), 'local', now)).toBe(
      'Thu 23:30:00',
    )
    expect(formatStamp(new Date(2026, 9, 3, 9, 12, 44).getTime(), 'local', now)).toBe(
      'Oct 3 09:12:44',
    )
    // 23:30 UTC on the 5th is the day before 00:30 UTC on the 6th, whatever the local clock says.
    expect(
      formatStamp(Date.parse('2026-11-05T23:30:00Z'), 'utc', Date.parse('2026-11-06T00:30:00Z')),
    ).toBe('Thu 23:30:00Z')
  })

  it('pluralizes a quantity unless it is exactly one', () => {
    expect(formatQuantity(1, 'minute')).toBe('1 minute')
    expect(formatQuantity(0, 'minute')).toBe('0 minutes')
    expect(formatQuantity(28, 'minute')).toBe('28 minutes')
  })
})
