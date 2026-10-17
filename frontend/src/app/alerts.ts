import { createContext, useContext } from 'react'
import type { EngineStatus, IncidentOverview } from '@/api/types'
import type { Resource } from '@/hooks/useResource'

export interface AlertsState {
  /** The open incidents of the scope: the API's counts over all of it, and the first few that matter. */
  overview: Resource<IncidentOverview>
  /** What the alert engine says about itself. It concerns no customer, so no scope. */
  engine: Resource<EngineStatus>
}

export const AlertsContext = createContext<AlertsState | null>(null)

/**
 * The shared alert figures (the topbar indicator, the Overview tile and panel, the Alerts screen's
 * engine line): one fetch serves them all, so they cannot disagree. Null where no provider is
 * mounted (the sign-in page, a test that does not need it): a caller then draws nothing, not a zero.
 */
export function useAlerts(): AlertsState | null {
  return useContext(AlertsContext)
}

/** The same, for a screen that cannot stand without it (the Overview's alert panel and tile). */
export function useRequiredAlerts(): AlertsState {
  const alerts = useContext(AlertsContext)
  if (!alerts) throw new Error('useRequiredAlerts must be used inside <AlertsProvider>')
  return alerts
}
