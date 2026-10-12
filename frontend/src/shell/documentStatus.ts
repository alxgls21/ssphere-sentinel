import type { StatusCounts } from '@/api/types'
import type { Verdict, VerdictState } from '@/lib/verdict'
import { STATUS_WORD } from '@/ui/status'

/** A tab title is plain text, so the status alphabet's SVG shapes are written as Unicode shapes. */
const TITLE_SEGMENT: Record<VerdictState, (counts: StatusCounts) => string> = {
  critical: (c) => `◆ ${c.critical} ${STATUS_WORD.critical}`,
  degraded: (c) => `▲ ${c.warning} ${STATUS_WORD.warning}`,
  partial: (c) => `○ ${c.unknown} ${STATUS_WORD.unknown}`,
  nominal: (c) => `● ${c.healthy} ${STATUS_WORD.healthy}`,
  nodata: () => '○ NO DATA',
}

interface TitleInput {
  mock: boolean
  /** null while the first load is in flight: a tab must not claim NO DATA for a fraction of a second. */
  verdict: Verdict | null
  screen: string
}

/**
 * "[MOCK] ◆ 4 CRIT - Overview - Sentinel": the verdict is readable from a
 * background tab, and a screenshot of the tab strip is marked as demo data.
 */
export function documentTitle({ mock, verdict, screen }: TitleInput): string {
  const prefix = mock ? '[MOCK] ' : ''
  if (!verdict) return `${prefix}${screen} - Sentinel`
  return `${prefix}${TITLE_SEGMENT[verdict.state](verdict.counts)} - ${screen} - Sentinel`
}

/** The sentence the announcer speaks when the verdict changes. */
export function verdictSentence(verdict: Verdict): string {
  const base = `Verdict ${verdict.word}.`
  return verdict.needAttention === null
    ? base
    : `${base} ${verdict.needAttention} of ${verdict.monitored} need attention.`
}
