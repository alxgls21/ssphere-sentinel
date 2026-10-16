import {
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { SummaryContext } from '@/app/summary'
import { scopeKey, useScope } from '@/app/viewState'
import { useViewTo } from '@/app/viewSearch'
import { NEXT_PROBLEM_EVENT, type NextProblemDetail } from '@/config/events'
import type { FeatureId } from '@/config/features'
import { useLiveResource } from '@/hooks/useLiveResource'
import { formatClock } from '@/lib/format'
import { computeVerdict } from '@/lib/verdict'
import { Button, Chip } from '@/ui/controls'
import { Panel } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { StatusGlyph } from '@/ui/status'
import { copyText } from './clipboard'
import { QueueSkeleton } from './QueueSkeleton'
import { QueueTable } from './QueueTable'
import {
  countItems,
  entityTarget,
  filterItems,
  hasSite,
  newCriticalKeys,
  nextFilter,
  rowCopyText,
  rowKey,
  updatesText,
  type QueueFilter,
  type QueueItem,
  type QueueSnapshot,
} from './queueModel'
import { recallRow, rememberRow } from './returnFocus'
import { useOrderLock } from './useOrderLock'
import { useQueueNavigation, type QueueActions } from './useQueueNavigation'

const FEATURES: readonly FeatureId[] = ['servers', 'docker', 'network']
const NO_ITEMS: QueueItem[] = []

/** A mouse click focuses a button too; only keyboard focus (a ring on screen) is worth keeping. */
function keyboardFocused(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * [1] Needs attention: the primary action surface. Non-healthy servers,
 * containers and targets, worst first, as given by the API. Keyboard first
 * (j/k, Enter, y, f, r) and calm under live updates: while the operator is in
 * the table the order is locked and new snapshots wait behind a pill (see
 * useOrderLock). Demo data until the screen is connected to the console API.
 */
export function AttentionQueuePanel({ className }: { className?: string }) {
  const api = useApi()
  const { pollMs, refreshToken } = useLive()
  const { tz, singleKeyShortcuts } = usePrefs()
  const { announce, flashStatus } = useShell()
  const [scope] = useScope()
  // Optional: the queue must also work where no shared summary is provided.
  const summary = useContext(SummaryContext)?.data
  const nothingMonitored = summary !== undefined && computeVerdict(summary, 'live').monitored === 0
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const location = useLocation()

  const [includeIdle, setIncludeIdle] = useState(false)
  const [filter, setFilter] = useState<QueueFilter>('all')
  const [expanded, setExpanded] = useState(false)
  // Read once: where the operator was when they last left this history entry.
  const [restoreKey] = useState(() => recallRow(location.state))

  const view = `${scopeKey(scope)}:${includeIdle ? 'idle' : 'active'}`
  const { status, data, error, isRefreshing, refetch } = useLiveResource(
    'attention',
    `attention:${view}`,
    async (signal): Promise<QueueSnapshot> => ({
      ...(await api.listAttention({ scope, includeIdle, signal })),
      view,
    }),
    // A scope or idle toggle keeps the previous rows, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )

  const lock = useOrderLock(data, { refreshToken, fetching: isRefreshing || status === 'loading' })
  const { snapshot, previous, queued } = lock

  const items = snapshot?.items ?? NO_ITEMS
  const counts = countItems(items)
  const rows = filterItems(items, filter)
  const newKeys = useMemo(() => newCriticalKeys(snapshot, previous), [snapshot, previous])
  // Ages are read against the clock of the data, so a frozen table stays internally consistent.
  const nowMs = snapshot ? Date.parse(snapshot.generatedAt) : 0
  const clock = (ms: number) => formatClock(ms, tz)

  const actions: QueueActions = {
    open: (item) => {
      // Leave a note on this history entry first, so Back finds the row again.
      const here = { pathname: location.pathname, search: location.search, hash: location.hash }
      void navigate(here, { replace: true, state: rememberRow(location.state, rowKey(item)) })
      const target = entityTarget(item)
      void navigate(viewTo(target.pathname, target.extra))
    },
    copy: (item) => {
      void copyText(rowCopyText(item, nowMs)).then((copied) =>
        flashStatus(copied ? 'Copied row' : 'Copy failed'),
      )
    },
    cycleFilter: () => setFilter(nextFilter),
    clearFilter: () => {
      if (filter === 'all') return false
      setFilter('all')
      return true
    },
    applyQueued: lock.apply,
  }

  const nav = useQueueNavigation({
    rows,
    ready: snapshot !== undefined,
    restoreKey,
    letterKeys: singleKeyShortcuts,
    actions,
  })

  // A control that disappears when pressed would take keyboard focus with it: land on the selected row instead.
  const keepPlace = (event: MouseEvent<HTMLElement>) => {
    if (keyboardFocused(event.currentTarget)) nav.focusSoon()
  }

  // Digit key 1 focuses the panel region itself; the selected row is where the operator belongs.
  const panelRef = useRef<HTMLElement>(null)
  const focusSelected = useEffectEvent(() => nav.focusActive())
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onFocus = (event: FocusEvent) => {
      if (event.target === panel) focusSelected()
    }
    panel.addEventListener('focus', onFocus)
    return () => panel.removeEventListener('focus', onFocus)
  }, [])

  // n / Shift+N from the global hotkey layer.
  const jumpToProblem = useEffectEvent((direction: unknown) => {
    if (direction === 1 || direction === -1) nav.focusProblem(direction)
  })
  useEffect(() => {
    const onNextProblem = (event: Event) =>
      jumpToProblem((event as CustomEvent<NextProblemDetail | undefined>).detail?.direction)
    window.addEventListener(NEXT_PROBLEM_EVENT, onNextProblem)
    return () => window.removeEventListener(NEXT_PROBLEM_EVENT, onNextProblem)
  }, [])

  // The pill is a visual cue; a screen-reader user in the table needs to hear that updates are waiting.
  const waiting = queued !== null
  const waitingCritical = (queued?.newCritical ?? 0) > 0
  const announceWaiting = useEffectEvent((critical: boolean) =>
    announce(
      critical ? 'New critical waiting. Press r to apply.' : 'Updates waiting. Press r to apply.',
    ),
  )
  useEffect(() => {
    if (waiting) announceWaiting(waitingCritical)
  }, [waiting, waitingCritical])

  const chips = (
    <fieldset className="flex min-w-0 gap-1">
      <legend className="sr-only">Filter by severity</legend>
      <Chip pressed={filter === 'all'} onPressedChange={() => setFilter('all')}>
        ALL
      </Chip>
      <Chip
        pressed={filter === 'critical'}
        onPressedChange={(pressed) => setFilter(pressed ? 'critical' : 'all')}
        count={snapshot ? counts.critical : undefined}
        leading={<StatusGlyph status="critical" size={10} />}
      >
        CRIT
      </Chip>
      <Chip
        pressed={filter === 'warning'}
        onPressedChange={(pressed) => setFilter(pressed ? 'warning' : 'all')}
        count={snapshot ? counts.warning : undefined}
        leading={<StatusGlyph status="warning" size={10} />}
      >
        WARN
      </Chip>
    </fieldset>
  )

  const footer = (
    <>
      <span className="min-w-0 truncate pointer-coarse:hidden">
        j/k move · Enter open · y copy · f filter
      </span>
      {snapshot && (snapshot.hiddenIdle > 0 || includeIdle) ? (
        <Button variant="ghost" size="sm" onClick={() => setIncludeIdle(!includeIdle)}>
          {includeIdle ? 'Hide idle' : `+${snapshot.hiddenIdle} hidden (idle)`}
        </Button>
      ) : null}
      {/* Resource, loss and latency limits are presentational: the backend has no alert rules. */}
      <span className="ml-auto shrink-0 text-fg-faint @max-lg:hidden">
        thresholds: UI defaults
        {/* The dagger in the SITE header, explained where it can be read without hovering. */}
        {hasSite(items) ? ' · † site: sample data' : ''}
      </span>
      {queued ? (
        <Button
          size="sm"
          aria-keyshortcuts="r"
          onClick={(event) => {
            keepPlace(event)
            lock.apply()
          }}
        >
          {queued.newCritical > 0 ? <StatusGlyph status="critical" size={10} /> : null}
          {updatesText(queued)}
        </Button>
      ) : null}
    </>
  )

  return (
    <Panel
      ref={panelRef}
      index={1}
      features={FEATURES}
      title="Needs attention"
      count={snapshot ? counts.problems : undefined}
      scope="NOW"
      actions={chips}
      refreshMs={pollMs}
      status={status}
      refreshing={isRefreshing}
      error={error}
      updatedAt={snapshot ? Date.parse(snapshot.generatedAt) : null}
      onRetry={refetch}
      isEmpty={snapshot !== undefined && items.length === 0}
      empty={
        // An empty fleet is not a healthy fleet: no green OK until something is actually monitored.
        nothingMonitored ? (
          <EmptyState
            title="Nothing is monitored yet"
            hint="No server, container or probe target reports to this scope."
          />
        ) : (
          <EmptyState
            glyph="healthy"
            title="Nothing needs attention"
            hint={`Checked ${clock(nowMs)}`}
          />
        )
      }
      skeleton={<QueueSkeleton />}
      footer={footer}
      flush
      // The table adapts to the width the panel is given (see QueueTable), not to the window.
      bodyClassName="@container flex flex-col"
      className={className}
    >
      {snapshot && rows.length === 0 ? (
        <EmptyState
          title={`No ${filter} items`}
          hint={
            <Button
              size="sm"
              onClick={(event) => {
                keepPlace(event)
                setFilter('all')
              }}
            >
              Show all {items.length}
            </Button>
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <QueueTable
          rows={rows}
          showSite={hasSite(items)}
          nowMs={nowMs}
          tz={tz}
          activeIndex={nav.activeIndex}
          newKeys={newKeys}
          expanded={expanded}
          onExpand={(event) => {
            keepPlace(event)
            setExpanded(true)
          }}
          scrollerRef={nav.scrollerRef}
          rowProps={nav.rowProps}
          lock={lock.bind}
        />
      ) : null}
    </Panel>
  )
}

export default AttentionQueuePanel
