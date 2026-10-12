import { useCallback, useContext, useEffect, useRef } from 'react'
import { HotkeyContext } from '@/app/hotkeys/mode'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { useAlerts } from '../alertsResource'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { AckButton } from './AckButton'
import { AlertRow } from './AlertRow'
import { ACK_MESSAGE, ALERT_ROWS, rankedAlerts } from './alertModel'

/** Placeholder rows at the real row height. */
function AlertsSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: ALERT_ROWS }, (_, index) => (
        <div key={index} className="flex h-(--row-h) items-center px-3">
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * [5] Active alerts: PLANNED. The backend has no alert engine, so these are
 * sample alerts derived from the same entities as every other panel. They
 * feed nothing (verdict, badges, title), and acknowledging is disabled with
 * a reason.
 */
export function ActiveAlertsPanel({ className }: { className?: string }) {
  const { pollMs } = useLive()
  const { flashStatus } = useShell()
  const { singleKeyShortcuts } = usePrefs()
  const panel = useRef<HTMLElement>(null)

  const { status, data, error, isRefreshing, updatedAt, refetch } = useAlerts()

  const explain = useCallback(() => flashStatus(ACK_MESSAGE), [flashStatus])

  // "g" then "a" goes to Alerts. While a chord is pending the second key belongs to the global
  // layer, so this panel must not take it. Optional: the panel also renders without that layer.
  const pending = useContext(HotkeyContext)?.pending ?? null
  const pendingRef = useRef(pending)
  useEffect(() => {
    pendingRef.current = pending
  })

  // Key a acknowledges. Panel exposes no key handler, but its section owns focus once
  // the operator has pressed 5 or tabbed in, and keydown bubbles up to it from any child.
  useEffect(() => {
    const element = panel.current
    if (!element || !singleKeyShortcuts) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyA' || event.repeat) return
      if (event.ctrlKey || event.altKey || event.metaKey) return
      if (pendingRef.current !== null) return
      event.preventDefault()
      explain()
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [singleKeyShortcuts, explain])

  // Ages are read against the moment of the snapshot, so a frozen (paused) panel stays consistent.
  const snapshot =
    data && updatedAt !== null ? { alerts: rankedAlerts(data), now: updatedAt } : undefined
  const hidden = snapshot ? snapshot.alerts.length - ALERT_ROWS : 0

  return (
    <Panel
      ref={panel}
      index={5}
      title="Active alerts"
      features="alerts"
      plannedNote="Alert engine not implemented."
      count={snapshot?.alerts.length}
      className={className}
      refreshMs={pollMs}
      status={status}
      refreshing={isRefreshing}
      error={error}
      updatedAt={updatedAt}
      onRetry={refetch}
      isEmpty={snapshot?.alerts.length === 0}
      empty={<EmptyState title="No active alerts" />}
      skeleton={<AlertsSkeleton />}
      flush
    >
      {snapshot ? (
        <>
          <ul>
            {snapshot.alerts.slice(0, ALERT_ROWS).map((alert) => (
              <AlertRow key={alert.id} alert={alert} now={snapshot.now} />
            ))}
          </ul>
          <div className="flex min-h-6 items-center gap-2 px-3">
            {hidden > 0 ? <span className="type-data text-fg-faint">+{hidden} more</span> : null}
            <span className="ml-auto">
              <AckButton onExplain={explain} />
            </span>
          </div>
        </>
      ) : null}
    </Panel>
  )
}
