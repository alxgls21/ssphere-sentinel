import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { IncidentDetail } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { EMPTY, formatAge, formatClock, formatDuration } from '@/lib/format'
import {
  CLOSE_REASON_TEXT,
  KIND_LABEL,
  STATUS_SENTENCE,
  conditionText,
  entityTarget,
  isOpen,
  openFor,
  timelineEvents,
} from '@/lib/incidents'
import { EventLog } from '@/ui/events/EventLog'
import { IncidentStatusTag, SeverityTag } from '@/ui/incidents'
import { PlaceName } from '@/ui/PlaceName'
import { Panel, type PanelProps } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'

type DataProps = Pick<PanelProps, 'status' | 'error' | 'onRetry' | 'updatedAt'>

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="type-label text-fg-faint">{label}</dt>
      <dd className="type-data min-w-0 text-fg">{children}</dd>
    </div>
  )
}

interface PanelProps2 extends DataProps {
  detail: IncidentDetail | undefined
  className?: string
}

/** A recorded moment: its clock time and how long ago, both from the API's timestamp. */
function Moment({ iso, nowMs }: { iso: string | null; nowMs: number }) {
  const { tz } = usePrefs()
  if (!iso) return <span className="text-fg-muted">{EMPTY}</span>
  return (
    <span>
      <time dateTime={iso}>{formatClock(Date.parse(iso), tz)}</time>
      <span className="text-fg-muted"> · {formatAge(iso, nowMs)} ago</span>
    </span>
  )
}

/**
 * [1] Summary: what the incident is on, which rule opened it and on what condition, when it
 * started and opened, who saw it, and how it ended. Every time is the API's. The object links to its
 * own page only where the API says this user may see it; where it does not, the incident says so
 * and offers nothing to open.
 */
export function IncidentSummaryPanel({ detail, className, ...data }: PanelProps2) {
  const viewTo = useViewTo()
  const item = detail?.item
  const nowMs = detail ? Date.parse(detail.generatedAt) : 0
  const target = item ? entityTarget(item.entity.kind, item.entity.ref) : null
  const open = item ? isOpen(item.status) : false
  const lasted =
    item && !open && item.closedAt
      ? formatDuration((Date.parse(item.closedAt) - Date.parse(item.openedAt)) / 1000)
      : null
  return (
    <Panel
      index={1}
      title="Summary"
      features="alerts"
      scope={open ? 'NOW' : 'ENDED'}
      className={className}
      {...data}
      skeleton={<div className="h-32" />}
    >
      {item && detail && target ? (
        <div className="flex flex-col gap-3">
          <p className="type-body flex flex-wrap items-center gap-x-3 gap-y-1">
            <SeverityTag severity={item.severity} />
            <IncidentStatusTag status={item.status} />
            <span>{STATUS_SENTENCE[item.status]}</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 @2xl:grid-cols-3">
            <Fact label="Monitored object">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-fg-muted">{KIND_LABEL[item.entity.kind]}</span>
                {detail.entityVisible ? (
                  <Link
                    to={viewTo(target.pathname, target.extra)}
                    className="type-data-strong min-w-0 truncate rounded-sm underline underline-offset-2 hover:text-primary"
                    title={`Open ${item.entity.label}`}
                  >
                    {item.entity.label}
                  </Link>
                ) : (
                  <>
                    <span className="type-data-strong min-w-0 truncate">{item.entity.label}</span>
                    <span className="type-body text-fg-muted">
                      It no longer exists, or you may not see it: there is no page to open.
                    </span>
                  </>
                )}
              </span>
            </Fact>
            <Fact label="Rule">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="type-data-strong min-w-0 truncate">{detail.rule.name}</span>
                {detail.rule.enabled ? null : (
                  <span className="type-body text-fg-muted">This rule is switched off now.</span>
                )}
              </span>
            </Fact>
            <Fact label="Trigger condition">{conditionText(item)}</Fact>
            <Fact label="Started">
              <Moment iso={item.startedAt} nowMs={nowMs} />
            </Fact>
            <Fact label="Opened">
              <Moment iso={item.openedAt} nowMs={nowMs} />
            </Fact>
            <Fact label={open ? 'Open for' : 'Lasted'}>
              {open ? openFor(item, nowMs) : (lasted ?? EMPTY)}
            </Fact>
            <Fact label="Acknowledged">
              {item.acknowledgedAt ? (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{item.acknowledgedBy ? `by ${item.acknowledgedBy}` : 'by someone'}</span>
                  <Moment iso={item.acknowledgedAt} nowMs={nowMs} />
                </span>
              ) : (
                <span className="text-fg-muted">
                  {item.status === 'active' ? 'not yet' : 'never: it ended before anyone did'}
                </span>
              )}
            </Fact>
            <Fact label="Recovered">
              {item.recoveredAt ? (
                <Moment iso={item.recoveredAt} nowMs={nowMs} />
              ) : (
                <span className="text-fg-muted">{open ? 'not yet' : EMPTY}</span>
              )}
            </Fact>
            <Fact label="Closed">
              {item.closedAt ? (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <Moment iso={item.closedAt} nowMs={nowMs} />
                  {item.closeReason ? (
                    <span className="type-body text-fg-muted">
                      {CLOSE_REASON_TEXT[item.closeReason]}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-fg-muted">{open ? 'still open' : EMPTY}</span>
              )}
            </Fact>
            <Fact label="Site">
              {item.siteName && item.customerName ? (
                <PlaceName
                  customer={item.customerName}
                  site={item.siteName}
                  className="type-body"
                />
              ) : (
                <span className="text-fg-muted">
                  none: the object was on no site when it opened
                </span>
              )}
            </Fact>
          </dl>
          {detail.rule.description ? (
            <p className="type-body text-fg-muted">
              <span className="type-label text-fg-faint">RULE </span>
              {detail.rule.description}
            </p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}

/**
 * [2] Timeline: the incident's recorded steps in the log's form, the opening with every later step
 * nested under it. Each line is one step at its recorded time (opened, acknowledged, recovery began
 * or was interrupted, recovered, closed); nothing is filled in between.
 */
export function IncidentTimelinePanel({ detail, className, ...data }: PanelProps2) {
  const events = detail ? timelineEvents(detail) : []
  return (
    <Panel
      index={2}
      title="Timeline"
      features="alerts"
      scope="RECORDED"
      count={detail ? events.length : undefined}
      className={className}
      {...data}
      isEmpty={detail !== undefined && events.length === 0}
      empty={
        <EmptyState title="No steps recorded" hint="The engine has recorded nothing for it yet." />
      }
      skeleton={<div className="h-40" />}
      flush
    >
      {detail ? (
        <div className="h-48">
          <EventLog
            events={events}
            view={detail.item.id}
            label="Incident timeline"
            description="The incident's recorded steps, newest first, with every step after the opening nested under it."
          />
        </div>
      ) : null}
    </Panel>
  )
}
