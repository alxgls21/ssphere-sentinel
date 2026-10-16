import type { Freshness } from '@/app/live'

/** "52s", "2m", "3h", "2d": one unit, as short as the chip can afford. */
export function compactAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

export interface FreshnessText {
  /** What the chip shows. It ticks every second, so it is hidden from assistive technology. */
  text: string
  /**
   * What assistive technology hears. It changes only when the state does:
   * "updating" is a normal part of live (every poll), so it is not a state here.
   * It says that updates arrive, never that the data is real: the chip does not know that.
   */
  spoken: string
}

/**
 * The chip's wording for each freshness state. The chip never uses the OK /
 * WARN / CRIT shapes (those are reserved for entity health): a stale screen
 * must not borrow the look of a healthy one.
 */
export function describeFreshness(state: Freshness, ageSeconds: number | null): FreshnessText {
  const age = ageSeconds === null ? '' : ` ${compactAge(ageSeconds)}`
  switch (state) {
    case 'live':
      return {
        text: ageSeconds === null ? 'updating' : `updated ${compactAge(ageSeconds)} ago`,
        spoken: 'Updates are arriving',
      }
    case 'fetching':
      return { text: 'updating', spoken: 'Updates are arriving' }
    case 'paused':
      return { text: `PAUSED${age}`, spoken: 'Updates are paused' }
    case 'stale':
      return { text: `STALE${age}`, spoken: 'Data is stale' }
    case 'nodata':
      return { text: `NO DATA${age}`, spoken: 'No data' }
  }
}
