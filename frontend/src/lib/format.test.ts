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

  it('pluralizes a quantity unless it is exactly one', () => {
    expect(formatQuantity(1, 'minute')).toBe('1 minute')
    expect(formatQuantity(0, 'minute')).toBe('0 minutes')
    expect(formatQuantity(28, 'minute')).toBe('28 minutes')
  })
})
