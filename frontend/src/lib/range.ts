import type { RangeKey } from '@/api/types'

export const RANGE_OPTIONS: readonly RangeKey[] = ['15m', '1h', '6h', '24h']
export const DEFAULT_RANGE: RangeKey = '1h'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** How much time each range covers. */
export const RANGE_MS: Record<RangeKey, number> = {
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': 24 * HOUR,
}

/** The range as a phrase for a sentence about the window: "last hour", "last 6 hours". */
export const RANGE_WORDS: Record<RangeKey, string> = {
  '15m': 'last 15 minutes',
  '1h': 'last hour',
  '6h': 'last 6 hours',
  '24h': 'last 24 hours',
}

export function isRangeKey(value: string | null): value is RangeKey {
  return value !== null && (RANGE_OPTIONS as readonly string[]).includes(value)
}

/** Next or previous range, wrapping (keys t / Shift+T). */
export function stepRange(current: RangeKey, direction: 1 | -1): RangeKey {
  const index = RANGE_OPTIONS.indexOf(current)
  const next = (index + direction + RANGE_OPTIONS.length) % RANGE_OPTIONS.length
  return RANGE_OPTIONS[next] as RangeKey
}
