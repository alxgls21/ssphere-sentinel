import { createContext, useContext } from 'react'
import type { Alert } from '@/api/types'
import type { Resource } from '@/hooks/useResource'

/**
 * The active alerts, loaded ONCE for the whole Overview. The Alerts tile and
 * the Active alerts panel read the same resource, so the page asks the API
 * once per poll, and the tile's count can never disagree with the panel's list.
 * Always sample data: the backend has no alert engine.
 */
export const AlertsContext = createContext<Resource<Alert[]> | null>(null)

export function useAlerts(): Resource<Alert[]> {
  const alerts = useContext(AlertsContext)
  if (!alerts) throw new Error('useAlerts must be used inside <AlertsProvider>')
  return alerts
}
