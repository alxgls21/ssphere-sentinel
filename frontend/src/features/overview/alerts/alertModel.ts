import type { Alert } from '@/api/types'

/** Alerts listed; the rest collapse into "+N more". */
export const ALERT_ROWS = 3

/** What the status bar says when the operator tries to acknowledge (key a, or the button). */
export const ACK_MESSAGE = 'Acknowledge: not implemented in backend'

/**
 * Critical before warning, then newest first. The API already sorts this way,
 * but "+N more" is only safe to hide if the three shown really are the worst.
 */
export function rankedAlerts(alerts: readonly Alert[]): Alert[] {
  return alerts.toSorted(
    (a, b) =>
      Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
      Date.parse(b.since) - Date.parse(a.since) ||
      a.id.localeCompare(b.id),
  )
}
