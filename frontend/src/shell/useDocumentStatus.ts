import { useEffect, useRef } from 'react'
import { useShowsDemoData } from '@/hooks/useProvenance'
import { useLive } from '@/app/live'
import { useShell } from '@/app/shell'
import { useSummary } from '@/app/summary'
import { VERDICT_STATUS, computeVerdict, type VerdictState } from '@/lib/verdict'
import { documentTitle, verdictSentence } from './documentStatus'
import { faviconHref, setFavicon } from './favicon'
import { useFreshness } from './topbar/useFreshness'

/**
 * Keeps the browser tab honest: the title and the favicon carry the verdict
 * ("[MOCK] ◆ 4 CRIT - Overview - Sentinel"), instantly and without animation, so
 * a wall of background tabs can be read at a glance. A verdict change is also
 * announced, but only once it has held for two poll cycles: a flapping fleet
 * must not talk over the operator.
 *
 * Mounted once, in its own component, because it re-evaluates every second
 * (the verdict depends on how old the data is) and must not re-render the shell.
 */
export function useDocumentStatus(screen: string): void {
  const { pollMs } = useLive()
  const { announce } = useShell()
  const summary = useSummary()
  const { state: freshness } = useFreshness()

  // Until the first answer there is no verdict, and a tab must not say NO DATA for 300 ms.
  const verdict = summary.status === 'loading' ? null : computeVerdict(summary.data, freshness)
  const mock = useShowsDemoData()

  const title = documentTitle({ mock, verdict, screen })
  useEffect(() => {
    document.title = title
  }, [title])

  const state = verdict?.state ?? null
  useEffect(() => {
    if (state === null) return
    const href = faviconHref(VERDICT_STATUS[state], mock)
    if (href) setFavicon(href)
  }, [state, mock])

  const latest = useRef(verdict)
  useEffect(() => {
    latest.current = verdict
  })
  // The verdict last spoken (or, before any change, the one the page started with).
  const spoken = useRef<VerdictState | null>(null)
  useEffect(() => {
    if (state === null) return
    if (spoken.current === null) {
      spoken.current = state
      return
    }
    if (state === spoken.current) return
    const timer = setTimeout(() => {
      spoken.current = state
      if (latest.current) announce(verdictSentence(latest.current))
    }, pollMs * 2)
    return () => clearTimeout(timer)
  }, [state, pollMs, announce])
}
