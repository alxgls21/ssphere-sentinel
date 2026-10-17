import { useMemo, type ReactNode } from 'react'
import { DEFAULT_LIMITS_IN_FORCE, ResourceLimitsContext } from '@/ui/meters/limits'
import { useAuth } from './auth/auth'

/**
 * Puts the resource limits the console API published with the session in force: the
 * meters, the history chart and the footers that print a limit all read them from here.
 * Limits that make no sense (not 0 to 100, or warn not below critical) are not used, and
 * the defaults stay in force, labelled as such.
 */
export function LimitsProvider({ children }: { children: ReactNode }) {
  const { thresholds } = useAuth()
  const warn = thresholds?.resourceWarnPercent
  const crit = thresholds?.resourceCritPercent
  const value = useMemo(
    () =>
      warn !== undefined && crit !== undefined && warn >= 0 && warn < crit && crit <= 100
        ? { warn, crit, origin: 'server' as const }
        : DEFAULT_LIMITS_IN_FORCE,
    [warn, crit],
  )
  return <ResourceLimitsContext.Provider value={value}>{children}</ResourceLimitsContext.Provider>
}
