import type { ReactNode } from 'react'
import { useApi } from '@/api/context'
import { useLiveResource } from '@/hooks/useLiveResource'
import { HIDDEN_POLL_MS } from '@/lib/thresholds'
import { SummaryContext } from './summary'
import { scopeKey, useScope } from './viewState'

export function SummaryProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const [scope] = useScope()
  const summary = useLiveResource(
    'summary',
    `summary:${scopeKey(scope)}`,
    (signal) => api.getOverviewSummary({ scope, signal }),
    {
      keepPreviousData: true,
      // The tab title and favicon read this: a background tab must not decay to NO DATA.
      hiddenRefreshMs: HIDDEN_POLL_MS,
    },
  )
  return <SummaryContext.Provider value={summary}>{children}</SummaryContext.Provider>
}
