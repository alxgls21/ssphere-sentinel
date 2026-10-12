import { EMPTY } from '@/lib/format'

interface NextPollInput {
  paused: boolean
  /** A request is in flight. */
  fetching: boolean
  pollMs: number
  /** Last successful load (client clock), or null before the first. */
  lastUpdatedAt: number | null
  now: number
}

/**
 * The status bar's words for the refresh hairline: it says "next poll 12s"
 * (or PAUSED, or updating) so the heartbeat is readable under reduced motion
 * and on a screen reader's braille line.
 */
export function nextPollText({
  paused,
  fetching,
  pollMs,
  lastUpdatedAt,
  now,
}: NextPollInput): string {
  if (paused) return 'PAUSED'
  if (fetching) return 'updating'
  if (lastUpdatedAt === null) return `next poll ${EMPTY}`
  const seconds = Math.max(0, Math.ceil((lastUpdatedAt + pollMs - now) / 1000))
  return `next poll ${seconds}s`
}
