import type { RangeKey } from '@/api/types'

/** Bucket size of a server's history for each range: the console API's (1 minute for 15m and 1h, 5 for 6h, 15 for 24h). */
export const BUCKET_MS: Record<RangeKey, number> = {
  '15m': 60_000,
  '1h': 60_000,
  '6h': 5 * 60_000,
  '24h': 15 * 60_000,
}
