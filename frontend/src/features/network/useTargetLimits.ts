import { useMemo } from 'react'
import { useOptionalAuth } from '@/app/auth/auth'
import { DEFAULT_TARGET_LIMITS, type TargetLimits } from '@/lib/targets'

/**
 * The limits the reasons and the chart quote: the ones the console API publishes with the session,
 * or, without them (the sample API), the console's own defaults, labelled as such.
 */
export function useTargetLimits(): TargetLimits {
  const thresholds = useOptionalAuth()?.thresholds
  return useMemo(
    () =>
      thresholds
        ? {
            latencyWarnMs: thresholds.probeLatencyWarnMs,
            lossWarnPercent: thresholds.probeLossWarnPercent,
            critFailures: thresholds.targetCritFailures,
            origin: 'server',
          }
        : DEFAULT_TARGET_LIMITS,
    [thresholds],
  )
}
