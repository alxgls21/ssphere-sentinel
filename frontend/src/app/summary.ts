import { createContext, useContext } from 'react'
import type { OverviewSummary } from '@/api/types'
import type { Resource } from '@/hooks/useResource'

export const SummaryContext = createContext<Resource<OverviewSummary> | null>(null)

/**
 * The shared headline counts (verdict, tiles, sidebar badges, tab title). One
 * fetch serves the whole shell, so the numbers can never disagree between the
 * sidebar and the Overview.
 */
export function useSummary(): Resource<OverviewSummary> {
  const summary = useContext(SummaryContext)
  if (!summary) throw new Error('useSummary must be used inside <SummaryProvider>')
  return summary
}
