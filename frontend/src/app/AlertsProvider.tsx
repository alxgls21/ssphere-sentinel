import type { ReactNode } from 'react'
import { useApi } from '@/api/context'
import { useLiveResource } from '@/hooks/useLiveResource'
import { HIDDEN_POLL_MS } from '@/lib/thresholds'
import { AlertsContext } from './alerts'
import { scopeKey, useScope } from './viewState'

/**
 * Fetches the open incidents of the topbar scope and the alert engine's state, once for the whole
 * shell. A failure is the resource's own error: nothing stands in for a count that was not read.
 */
export function AlertsProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const [scope] = useScope()
  const overview = useLiveResource(
    'incidents',
    `incidents:${scopeKey(scope)}`,
    (signal) => api.getIncidentOverview({ scope, signal }),
    // A scope change keeps the last count, dimmed, rather than a blank where a number was.
    { keepPreviousData: true, hiddenRefreshMs: HIDDEN_POLL_MS },
  )
  const engine = useLiveResource(
    'alert-engine',
    'alert-engine',
    (signal) => api.getEngineStatus({ signal }),
    { keepPreviousData: true, hiddenRefreshMs: HIDDEN_POLL_MS },
  )
  return <AlertsContext.Provider value={{ overview, engine }}>{children}</AlertsContext.Provider>
}
