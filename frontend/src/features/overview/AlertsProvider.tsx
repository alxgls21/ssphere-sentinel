import type { ReactNode } from 'react'
import { useApi } from '@/api/context'
import { scopeKey, useScope } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import { AlertsContext } from './alertsResource'

export function AlertsProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const [scope] = useScope()
  const alerts = useLiveResource(
    'alerts',
    `alerts:${scopeKey(scope)}`,
    (signal) => api.listAlerts({ scope, state: 'active', signal }),
    // A scope change keeps the previous render, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  return <AlertsContext.Provider value={alerts}>{children}</AlertsContext.Provider>
}
