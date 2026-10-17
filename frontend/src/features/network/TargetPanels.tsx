import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type {
  TargetAvailability,
  TargetDetail,
  TargetListItem,
  TargetMeasurement,
} from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { EMPTY, formatAge, formatClock, formatLatency } from '@/lib/format'
import {
  LOSS_LABEL,
  coverageText,
  endpointText,
  isCurrent,
  lossText,
  measuredAgo,
  observedText,
  probesText,
  protocolText,
  reasonSentence,
  reasonWord,
  scheduleText,
  type TargetLimits,
} from '@/lib/targets'
import { PlaceName } from '@/ui/PlaceName'
import { Panel, type PanelProps } from '@/ui/Panel'
import { EmptyState, SkeletonRows } from '@/ui/states'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { agentServerPath } from './networkModel'

type DataProps = Pick<PanelProps, 'status' | 'error' | 'onRetry' | 'updatedAt'>

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="type-label text-fg-faint">{label}</dt>
      <dd className="type-data min-w-0 truncate text-fg">{children}</dd>
    </div>
  )
}

/** The newest measurement, said as a current reading only where the API judged health from it. */
function LastMeasurement({
  item,
  measurement,
  nowMs,
}: {
  item: TargetListItem
  measurement: TargetMeasurement
  nowMs: number
}) {
  const { tz } = usePrefs()
  const { protocol } = item.target
  const current = isCurrent(item)
  const at = formatClock(Date.parse(measurement.measuredAt), tz)
  return (
    <section
      aria-label={current ? 'Current measurement' : 'Last measurement'}
      className="flex flex-col gap-1.5"
    >
      <h3 className="type-label flex items-center gap-2 text-fg-muted">
        {current ? 'Current measurement' : 'Last measurement'}
        {current ? null : <StatusTag status="unknown" word="NOT CURRENT" />}
      </h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
        <Fact label="Measured">
          <span title={at}>{measuredAgo(measurement, nowMs)}</span>
        </Fact>
        <Fact label="Result">{measurement.success ? 'answered' : 'no answer'}</Fact>
        <Fact label="Latency">
          {measurement.latencyMs === null ? EMPTY : formatLatency(measurement.latencyMs)}
        </Fact>
        <Fact label={LOSS_LABEL[protocol]}>{lossText(protocol, measurement.lossPercent)}</Fact>
        <Fact label="Probes">{probesText(measurement, protocol)}</Fact>
        {measurement.failureReason ? (
          <Fact label="Failure">{measurement.failureReason}</Fact>
        ) : null}
      </dl>
    </section>
  )
}

interface SummaryPanelProps extends DataProps {
  item: TargetListItem | undefined
  nowMs: number
  limits: TargetLimits
  className?: string
}

/**
 * [1] Summary: who the target is, what it is configured to do, which agent measures it, how it is
 * doing and why (the API's own reason), and its newest measurement, labelled as not current
 * whenever it is not.
 */
export function TargetSummaryPanel({ item, nowMs, limits, className, ...data }: SummaryPanelProps) {
  const { tz } = usePrefs()
  const viewTo = useViewTo()
  const target = item?.target
  const agent = target?.agent ?? null
  return (
    <Panel
      index={1}
      title="Summary"
      features="network"
      scope={item && !isCurrent(item) ? 'LAST MEASUREMENT' : 'NOW'}
      className={className}
      {...data}
      skeleton={<div className="h-28" />}
    >
      {item && target ? (
        <div className="flex flex-col gap-3">
          <p className="type-body flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusTag
              status={item.health}
              word={reasonWord(item.reason, target.protocol)}
              variant="tag"
            />
            <span>{reasonSentence(item, nowMs, limits)}</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
            <Fact label="Target">{endpointText(item)}</Fact>
            <Fact label="Protocol">{protocolText(item)}</Fact>
            <Fact label="Monitoring">{target.enabled ? scheduleText(item) : 'switched off'}</Fact>
            <Fact label="Circuit">{target.circuitId ?? EMPTY}</Fact>
            <Fact label="Site">
              {item.siteName && item.customerName ? (
                <PlaceName
                  customer={item.customerName}
                  site={item.siteName}
                  className="type-body"
                />
              ) : (
                EMPTY
              )}
            </Fact>
            <Fact label="Agent">
              {agent ? (
                <Link
                  to={viewTo(agentServerPath(agent.serverId))}
                  className="rounded-sm underline underline-offset-2 hover:text-primary"
                  title={`Open ${agent.serverName}`}
                >
                  {agent.name}
                </Link>
              ) : target.agentAssigned ? (
                'assigned'
              ) : (
                'none assigned'
              )}
            </Fact>
            <Fact label="Agent status">{agent ? agent.status : EMPTY}</Fact>
            <Fact label="Agent last seen">
              {agent?.lastSeenAt ? (
                <span title={formatClock(Date.parse(agent.lastSeenAt), tz)}>
                  {formatAge(agent.lastSeenAt, nowMs)} ago
                </span>
              ) : (
                EMPTY
              )}
            </Fact>
          </dl>
          {item.latest ? (
            <LastMeasurement item={item} measurement={item.latest} nowMs={nowMs} />
          ) : (
            <p className="type-body text-fg-muted">Nothing has been measured yet.</p>
          )}
        </div>
      ) : null}
    </Panel>
  )
}

interface AvailabilityPanelProps extends DataProps {
  availability: TargetAvailability | undefined
  className?: string
}

/**
 * [3] Observed availability over the last 24 hours: the share of the measurements taken that
 * succeeded, and, apart from it, how much of the window was measured at all. An observation, never
 * an SLA, a guarantee or an uptime.
 */
export function AvailabilityPanel({ availability, className, ...data }: AvailabilityPanelProps) {
  return (
    <Panel
      index={3}
      title="Observed availability"
      features="network"
      scope="24h"
      className={className}
      {...data}
      skeleton={<SkeletonRows count={2} className="p-3" />}
    >
      {availability ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-baseline gap-2">
            <span className="type-kpi tnum">
              {availability.percent === null
                ? EMPTY
                : `${availability.percent.toFixed(availability.percent === 100 ? 0 : 1)}%`}
            </span>
            <span className="type-data text-fg-muted">observed success rate</span>
          </p>
          <dl className="grid grid-cols-1 gap-y-2 @lg:grid-cols-2 @lg:gap-x-6">
            <Fact label="Succeeded">{observedText(availability)}</Fact>
            <Fact label="Coverage">{coverageText(availability)}</Fact>
          </dl>
          <p className="type-data text-fg-faint">
            The share of the measurements taken that succeeded. It is an observation, not an SLA or
            an uptime guarantee: where coverage is below 100% the agent did not measure all along.
          </p>
        </div>
      ) : null}
    </Panel>
  )
}

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

interface MeasurementsPanelProps extends DataProps {
  detail: TargetDetail | undefined
  className?: string
}

/** [4] The newest measurements, newest first, each as the agent reported it. */
export function MeasurementsPanel({ detail, className, ...data }: MeasurementsPanelProps) {
  const { tz } = usePrefs()
  const protocol = detail?.item.target.protocol ?? 'icmp'
  const rows = detail?.measurements ?? []
  return (
    <Panel
      index={4}
      title="Recent measurements"
      features="network"
      scope="NOW"
      className={className}
      count={detail ? rows.length : undefined}
      {...data}
      isEmpty={detail !== undefined && rows.length === 0}
      empty={<EmptyState title="No measurements" hint="This target has not been measured yet." />}
      skeleton={<SkeletonRows count={4} className="p-3" />}
      flush
    >
      <div className="h-full overflow-auto">
        <table aria-label="Recent measurements" className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th scope="col" className={cn(HEAD, 'pl-4')}>
                MEASURED
              </th>
              <th scope="col" className={cn(HEAD, 'px-3')}>
                RESULT
              </th>
              <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
                LATENCY
              </th>
              <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
                {LOSS_LABEL[protocol].toUpperCase()}
              </th>
              <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @xl:table-cell')}>
                PROBES
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={`${row.measuredAt}-${index}`}
                className="relative h-(--row-h) hover:bg-hover"
              >
                <td className={cn(CELL, 'type-data tnum relative pl-4')}>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute inset-y-0 left-0 w-0.5',
                      row.success ? 'bg-transparent' : STATUS_EDGE.warning,
                    )}
                  />
                  {formatClock(Date.parse(row.measuredAt), tz)}
                </td>
                <td className={cn(CELL, 'type-data px-3')} title={row.failureReason ?? undefined}>
                  {row.success ? 'answered' : (row.failureReason ?? 'no answer')}
                </td>
                <td className={cn(CELL, 'type-data tnum px-3 text-right')}>
                  {row.latencyMs === null ? EMPTY : formatLatency(row.latencyMs)}
                </td>
                <td className={cn(CELL, 'type-data tnum px-3 text-right')}>
                  {lossText(protocol, row.lossPercent)}
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @xl:table-cell')}>
                  {row.successfulProbes}/{row.probeCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
