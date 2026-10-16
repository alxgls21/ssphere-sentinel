import { describe, expect, it } from 'vitest'
import type { ServerSeries } from '@/api/types'
import { historyLabel } from './historyModel'

const MINUTE = 60_000

/** `count` buckets of `bucketMs` each: only the span matters to a label. */
function span(count: number, bucketMs: number): ServerSeries {
  return {
    generatedAt: '2026-10-12T14:00:00Z',
    bucketMs,
    t: Array.from({ length: count }, (_, i) => i * bucketMs),
    cpu: [],
    memory: [],
    disk: [],
  }
}

describe('historyLabel', () => {
  it.each([
    [15, MINUTE, 'last 15 minutes'],
    [60, MINUTE, 'last hour'],
    [72, 5 * MINUTE, 'last 6 hours'],
    [96, 15 * MINUTE, 'last 24 hours'],
  ])('names a series of %i buckets by the range it covers', (count, bucketMs, words) => {
    expect(historyLabel('CPU', 'api-02', span(count, bucketMs))).toBe(
      `CPU history of api-02, ${words}`,
    )
  })

  it('names no range it cannot tell, rather than guessing one', () => {
    expect(historyLabel('Disk', 'api-02', span(7, MINUTE))).toBe('Disk history of api-02')
    expect(historyLabel('Disk', 'api-02', span(0, MINUTE))).toBe('Disk history of api-02')
  })
})
