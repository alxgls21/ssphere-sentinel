import type { StatusCounts } from '@/api/types'
import type { Freshness } from '@/app/live'
import type { FeatureId } from '@/config/features'
import { describeCounts, nonZeroCounts, spokenStatus } from '@/lib/blocks'
import { EMPTY, formatInteger } from '@/lib/format'
import { needsAttention } from '@/lib/status'
import { NO_DATA_AFTER_SECONDS } from '@/lib/thresholds'
import type { Verdict } from '@/lib/verdict'

/** The domains the verdict counts. SNMP and alerts are deliberately absent: they are planned. */
export const VERDICT_FEATURES: readonly FeatureId[] = ['servers', 'docker', 'network']

/**
 * What the verdict leaves out, and what it rests on, stated wherever it is explained: the warn and
 * critical levels are presentational defaults (the backend has no alert rules).
 */
export const NOT_COUNTED =
  'Alerts, events and SNMP devices are not counted: not implemented in backend. Warn and critical levels are UI defaults, not backend rules.'

/** "4 critical, 5 warning": the counts that need a look, in words, worst first. Empty when none. */
export function describeProblems(counts: StatusCounts): string {
  return nonZeroCounts(counts)
    .filter(({ status }) => needsAttention(status))
    .map(({ status, count }) => `${formatInteger(count)} ${spokenStatus(status)}`)
    .join(', ')
}

/** The hero figure is at most three digits wide; anything above reads 999+. */
export function formatFigure(value: number | null): string {
  if (value === null) return EMPTY
  return value > 999 ? '999+' : formatInteger(value)
}

export interface VerdictText {
  /** The 48px figure: entities needing attention, or an em dash without data. */
  figure: string
  /** Under the verdict word: "need attention of 121", or why there is no verdict. */
  caption: string
  /** One line for the compact bar: "9 need attention". */
  short: string
  /** Everything the block shows, in words: the accessible name after "Fleet status: ". */
  summary: string
  /** What the count excludes: idle entities and the planned domains. Tooltip and description. */
  scope: string
}

export interface VerdictContext {
  /** The summary resource has data (it may be old). */
  hasData: boolean
  freshness: Freshness
}

export function describeVerdict(
  verdict: Verdict,
  { hasData, freshness }: VerdictContext,
): VerdictText {
  const figure = formatFigure(verdict.needAttention)
  const word = verdict.word.toLowerCase()

  if (verdict.needAttention === null) {
    const reason = !hasData
      ? 'no data received'
      : freshness === 'nodata'
        ? `data older than ${NO_DATA_AFTER_SECONDS / 60} min`
        : 'nothing monitored yet'
    return {
      figure,
      caption: reason,
      short: reason,
      summary: `${word}, ${reason}`,
      scope: NOT_COUNTED,
    }
  }

  const monitored = formatInteger(verdict.monitored)
  const idle =
    verdict.idle > 0
      ? `${formatInteger(verdict.idle)} idle ${verdict.idle === 1 ? 'entity is' : 'entities are'} not counted. `
      : ''
  return {
    figure,
    caption: `need attention of ${monitored}`,
    short: `${figure} need attention`,
    // Idle is reported apart ("scope"), so the spoken counts match the bar.
    summary: `${word}, ${figure} need attention of ${monitored}, ${describeCounts({ ...verdict.counts, idle: 0 })}`,
    scope: `${idle}${NOT_COUNTED}`,
  }
}
