import type { RangeKey } from '@/api/types'

export const RANGE_OPTIONS: readonly RangeKey[] = ['15m', '1h', '6h', '24h']
export const DEFAULT_RANGE: RangeKey = '1h'

export function isRangeKey(value: string | null): value is RangeKey {
  return value !== null && (RANGE_OPTIONS as readonly string[]).includes(value)
}

/** Next or previous range, wrapping (keys t / Shift+T). */
export function stepRange(current: RangeKey, direction: 1 | -1): RangeKey {
  const index = RANGE_OPTIONS.indexOf(current)
  const next = (index + direction + RANGE_OPTIONS.length) % RANGE_OPTIONS.length
  return RANGE_OPTIONS[next] as RangeKey
}
