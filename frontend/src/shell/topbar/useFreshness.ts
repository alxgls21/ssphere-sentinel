import { computeFreshness, useLive, useLiveSnapshot, type Freshness } from '@/app/live'
import { useNow } from '../useNow'

/** How far to trust the screen right now: the shared freshness rules on a one-second clock. */
export function useFreshness(): { state: Freshness; ageSeconds: number | null } {
  const snapshot = useLiveSnapshot()
  const { paused } = useLive()
  const now = useNow()
  return computeFreshness({ now, snapshot, paused })
}
