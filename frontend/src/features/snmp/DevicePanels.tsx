/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A value that is not a present reading carries its reason in a tooltip. It takes a tab stop so a
   keyboard user can open it, and names the same sentence for a screen reader. */
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { DeviceDetail, DeviceInterface, DeviceListItem } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import {
  DEVICE_TYPE_LABEL,
  deviceReasonSentence,
  deviceReasonWord,
  interfaceCountsSpoken,
  interfaceReasonSentence,
  interfaceReasonWord,
  interfaceStateText,
  interfaceTitle,
  isCurrentDevice,
  pollErrorText,
  pollScheduleText,
  polledAgo,
  rateText,
  snmpText,
  speedText,
  type RateCell,
} from '@/lib/devices'
import { EMPTY, formatAge, formatClock, formatDuration, formatLatency } from '@/lib/format'
import { Tooltip } from '@/ui/controls'
import { PlaceName } from '@/ui/PlaceName'
import { Panel, type PanelProps } from '@/ui/Panel'
import { EmptyState, SkeletonRows } from '@/ui/states'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { agentServerPath } from './snmpModel'

type DataProps = Pick<PanelProps, 'status' | 'error' | 'onRetry' | 'updatedAt'>

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="type-label text-fg-faint">{label}</dt>
      <dd className="type-data min-w-0 truncate text-fg">{children}</dd>
    </div>
  )
}

interface SummaryPanelProps extends DataProps {
  item: DeviceListItem | undefined
  nowMs: number
  className?: string
}

/**
 * [1] Summary: who the device is and how it is polled, which agent polls it, its health and why
 * (the API's own reason), and its latest poll, said as the present state only where it is. The
 * system information is what the device reported at its last successful poll. Nothing about
 * credentials is read or shown.
 */
export function DeviceSummaryPanel({ item, nowMs, className, ...data }: SummaryPanelProps) {
  const { tz } = usePrefs()
  const viewTo = useViewTo()
  const device = item?.device
  const agent = device?.agent ?? null
  const state = item?.state ?? null
  const current = item !== undefined && isCurrentDevice(item)
  const at = (iso: string) => formatClock(Date.parse(iso), tz)
  return (
    <Panel
      index={1}
      title="Summary"
      features="snmp"
      scope={state && !current ? 'LAST POLL' : 'NOW'}
      className={className}
      {...data}
      skeleton={<div className="h-28" />}
    >
      {item && device ? (
        <div className="flex flex-col gap-3">
          <p className="type-body flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusTag status={item.health} word={deviceReasonWord(item.reason)} variant="tag" />
            <span>{deviceReasonSentence(item, nowMs)}</span>
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
            <Fact label="Address">{device.address}</Fact>
            <Fact label="Type">{DEVICE_TYPE_LABEL[device.type]}</Fact>
            <Fact label="SNMP">{snmpText(item)}</Fact>
            <Fact label="Polling">{device.enabled ? pollScheduleText(item) : 'switched off'}</Fact>
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
              ) : device.agentAssigned ? (
                'assigned'
              ) : (
                'none assigned'
              )}
            </Fact>
            <Fact label="Agent status">{agent ? agent.status : EMPTY}</Fact>
            <Fact label="Agent last seen">
              {agent?.lastSeenAt ? (
                <span title={at(agent.lastSeenAt)}>{formatAge(agent.lastSeenAt, nowMs)} ago</span>
              ) : (
                EMPTY
              )}
            </Fact>
          </dl>
          {state ? (
            <section
              aria-label={current ? 'Current poll' : 'Last poll'}
              className="flex flex-col gap-1.5"
            >
              <h3 className="type-label flex items-center gap-2 text-fg-muted">
                {current ? 'Latest poll' : 'Last poll'}
                {current ? null : <StatusTag status="unknown" word="NOT CURRENT" />}
              </h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
                <Fact label="Polled">
                  <span title={at(state.lastPollAt)}>{polledAgo(item, nowMs)}</span>
                </Fact>
                <Fact label="Result">
                  {state.reachable
                    ? 'reached'
                    : `unreachable${state.error ? `: ${pollErrorText(state.error)}` : ''}`}
                </Fact>
                <Fact label="Response time">
                  {state.responseMs === null ? EMPTY : formatLatency(state.responseMs)}
                </Fact>
                <Fact label="Last successful poll">
                  {state.lastSuccessAt ? (
                    <span title={at(state.lastSuccessAt)}>
                      {formatAge(state.lastSuccessAt, nowMs)} ago
                    </span>
                  ) : (
                    'never'
                  )}
                </Fact>
              </dl>
            </section>
          ) : (
            <p className="type-body text-fg-muted">It has not been polled yet.</p>
          )}
          {state && (state.sysName || state.sysDescr || state.sysObjectId) ? (
            <section aria-label="System information" className="flex flex-col gap-1.5">
              <h3 className="type-label text-fg-muted">System information (from the last poll)</h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
                <Fact label="sysName">{state.sysName ?? EMPTY}</Fact>
                <Fact label="Uptime at the last poll">
                  {state.uptimeSeconds === null ? EMPTY : formatDuration(state.uptimeSeconds)}
                </Fact>
                <Fact label="sysObjectID">{state.sysObjectId ?? EMPTY}</Fact>
                <Fact label="Last discovery">
                  {state.lastDiscoveryAt ? (
                    <span title={at(state.lastDiscoveryAt)}>
                      {formatAge(state.lastDiscoveryAt, nowMs)} ago
                    </span>
                  ) : (
                    EMPTY
                  )}
                </Fact>
              </dl>
              {state.sysDescr ? (
                <p className="type-data text-fg-muted" title={state.sysDescr}>
                  <span className="text-fg-faint">sysDescr </span>
                  <span className="line-clamp-2 break-words">{state.sysDescr}</span>
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

interface PollsPanelProps extends DataProps {
  detail: DeviceDetail | undefined
  className?: string
}

/** [3] The newest polls, newest first, each as the agent reported it. */
export function PollsPanel({ detail, className, ...data }: PollsPanelProps) {
  const { tz } = usePrefs()
  const rows = detail?.polls ?? []
  return (
    <Panel
      index={3}
      title="Recent polls"
      features="snmp"
      scope="NOW"
      className={className}
      count={detail ? rows.length : undefined}
      {...data}
      isEmpty={detail !== undefined && rows.length === 0}
      empty={<EmptyState title="No polls" hint="This device has not been polled yet." />}
      skeleton={<SkeletonRows count={4} className="p-3" />}
      flush
    >
      <div className="h-full max-h-80 overflow-auto">
        <table aria-label="Recent polls" className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th scope="col" className={cn(HEAD, 'pl-4')}>
                POLLED
              </th>
              <th scope="col" className={cn(HEAD, 'px-3')}>
                RESULT
              </th>
              <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
                RESPONSE
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
                      row.reachable ? 'bg-transparent' : STATUS_EDGE.critical,
                    )}
                  />
                  {formatClock(Date.parse(row.measuredAt), tz)}
                </td>
                <td className={cn(CELL, 'type-data px-3')}>
                  {row.reachable
                    ? 'reached'
                    : `unreachable${row.error ? `: ${pollErrorText(row.error)}` : ''}`}
                </td>
                <td className={cn(CELL, 'type-data tnum px-3 text-right')}>
                  {row.responseMs === null ? EMPTY : formatLatency(row.responseMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/** A rate cell: the value, or a dash with the reason in a tooltip. */
function Reading({ cell }: { cell: RateCell }) {
  return cell.note ? (
    <Tooltip content={cell.note}>
      <span tabIndex={0} aria-label={cell.note} className="text-fg-muted">
        {cell.text}
      </span>
    </Tooltip>
  ) : (
    <span>{cell.text}</span>
  )
}

/** Two readings, inbound then outbound, each with its own reason where it has none. */
function Pair({ a, b }: { a: RateCell; b: RateCell }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <Reading cell={a} />
      <span aria-hidden="true" className="text-fg-faint">
        /
      </span>
      <Reading cell={b} />
    </span>
  )
}

interface InterfacesPanelProps extends DataProps {
  detail: DeviceDetail | undefined
  nowMs: number
  selected: number | null
  onSelect: (ifIndex: number | null) => void
  className?: string
}

/** The row's own state and reason: admin down, operationally down, up, unknown and device unavailable apart. */
function InterfaceState({ iface }: { iface: DeviceInterface }) {
  const word = interfaceReasonWord(iface.reason)
  const sentence = interfaceReasonSentence(iface)
  return (
    <Tooltip content={sentence}>
      <span tabIndex={0} className="inline-flex" aria-label={`${word}. ${sentence}`}>
        <StatusTag status={iface.health} word={word} variant="tag" />
      </span>
    </Tooltip>
  )
}

/**
 * [4] Interfaces: the ones the device lists now, by ifIndex. Each row has its own health and
 * reason from the API, and an interface that is down never makes its device unhealthy. The rates
 * are the API's, for the latest sample: where a sample gave none the cell is a dash with the
 * reason, never 0, and where the device is not current the whole table says its states are the
 * last stored ones.
 */
export function InterfacesPanel({
  detail,
  nowMs,
  selected,
  onSelect,
  className,
  ...data
}: InterfacesPanelProps) {
  const { tz } = usePrefs()
  const rows = detail?.interfaces ?? []
  const item = detail?.item
  const unavailable = item !== undefined && item.reason !== 'ok'
  return (
    <Panel
      index={4}
      title="Interfaces"
      features="snmp"
      scope="NOW"
      className={className}
      count={detail ? rows.length : undefined}
      {...data}
      isEmpty={detail !== undefined && rows.length === 0}
      empty={
        <EmptyState
          title="No interfaces listed"
          hint="The device has not listed any interface yet, or its listing is not available."
        />
      }
      skeleton={<SkeletonRows count={5} className="p-3" />}
      footer={
        item ? (
          <span className="truncate" title={interfaceCountsSpoken(item)}>
            {interfaceCountsSpoken(item)}
          </span>
        ) : undefined
      }
      flush
    >
      {unavailable && item ? (
        <p className="type-body border-b border-border px-3 py-2 text-fg-muted">
          The device is not current ({deviceReasonWord(item.reason).toLowerCase()}): the states and
          rates below are the last ones stored, not the present ones, and an interface is not called
          down for it.
        </p>
      ) : null}
      <div className="max-h-[32rem] overflow-auto">
        <table aria-label="Interfaces" className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th scope="col" className={cn(HEAD, 'pl-4')}>
                STATE
              </th>
              <th scope="col" className={cn(HEAD, 'px-3')}>
                IF
              </th>
              <th scope="col" className={cn(HEAD, 'px-1')}>
                NAME
              </th>
              <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
                ADMIN / OPER
              </th>
              <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @2xl:table-cell')}>
                SPEED
              </th>
              <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @xl:table-cell')}>
                IN / OUT
              </th>
              <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @4xl:table-cell')}>
                UTILIZATION
              </th>
              <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @5xl:table-cell')}>
                ERRORS/S
              </th>
              <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @5xl:table-cell')}>
                DISCARDS/S
              </th>
              <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
                SAMPLED
              </th>
              <th scope="col" className={cn(HEAD, 'pr-3 text-right')}>
                HISTORY
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((iface) => {
              const picked = selected === iface.ifIndex
              const sampled = iface.rates?.measuredAt ?? null
              return (
                <tr
                  key={iface.ifIndex}
                  aria-current={picked ? 'true' : undefined}
                  className={cn('relative h-(--row-h) hover:bg-hover', picked && 'bg-hover')}
                >
                  <td className={cn(CELL, 'relative pr-2 pl-4')}>
                    <span
                      aria-hidden="true"
                      className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[iface.health])}
                    />
                    <InterfaceState iface={iface} />
                  </td>
                  <td className={cn(CELL, 'type-data tnum px-3 text-fg-muted')}>{iface.ifIndex}</td>
                  <td className={cn(CELL, 'type-data-strong max-w-56 truncate px-1')}>
                    <span title={iface.descr ?? undefined}>{interfaceTitle(iface)}</span>
                  </td>
                  <td className={cn(CELL, 'type-data hidden px-3 text-fg-muted @3xl:table-cell')}>
                    {interfaceStateText(iface)}
                  </td>
                  <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @2xl:table-cell')}>
                    {iface.speedBps === null ? (
                      <Tooltip content="The device does not report a speed for this interface.">
                        <span
                          tabIndex={0}
                          className="text-fg-muted"
                          aria-label="speed not reported"
                        >
                          {EMPTY}
                        </span>
                      </Tooltip>
                    ) : (
                      speedText(iface)
                    )}
                  </td>
                  <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @xl:table-cell')}>
                    <Pair
                      a={rateText(iface, (r) => r.inBps, 'bps')}
                      b={rateText(iface, (r) => r.outBps, 'bps')}
                    />
                  </td>
                  <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @4xl:table-cell')}>
                    <Pair
                      a={rateText(iface, (r) => r.inUtilizationPercent, 'percent')}
                      b={rateText(iface, (r) => r.outUtilizationPercent, 'percent')}
                    />
                  </td>
                  <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @5xl:table-cell')}>
                    <Pair
                      a={rateText(iface, (r) => r.inErrorsPerSec, 'perSecond')}
                      b={rateText(iface, (r) => r.outErrorsPerSec, 'perSecond')}
                    />
                  </td>
                  <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @5xl:table-cell')}>
                    <Pair
                      a={rateText(iface, (r) => r.inDiscardsPerSec, 'perSecond')}
                      b={rateText(iface, (r) => r.outDiscardsPerSec, 'perSecond')}
                    />
                  </td>
                  <td className={cn(CELL, 'type-data tnum px-3 text-right')}>
                    {sampled === null ? (
                      <span className="text-fg-muted">never</span>
                    ) : (
                      <span title={formatClock(Date.parse(sampled), tz)}>
                        {formatAge(sampled, nowMs)} ago
                      </span>
                    )}
                  </td>
                  <td className={cn(CELL, 'pr-3 text-right')}>
                    <button
                      type="button"
                      aria-pressed={picked}
                      aria-label={`History of ${interfaceTitle(iface)}`}
                      onClick={() => onSelect(picked ? null : iface.ifIndex)}
                      className={cn(
                        'type-data rounded-sm px-1.5 py-0.5 -outline-offset-2 hover:text-fg',
                        picked ? 'bg-raised text-fg' : 'text-primary',
                      )}
                    >
                      {picked ? 'shown' : 'show'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
