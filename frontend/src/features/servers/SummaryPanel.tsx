import type { ServerListItem, ServerSeries } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { EMPTY, formatBytes, formatClock } from '@/lib/format'
import { Panel, type PanelProps } from '@/ui/Panel'
import { CellMeter, Sparkline } from '@/ui/meters'
import { historyLabel, valuesOf } from './historyModel'
import { reportsLoad } from '@/lib/serverList'
import { heartbeatText, uptimeText } from './serversModel'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="type-label text-fg-faint">{label}</dt>
      <dd className="type-data min-w-0 truncate text-fg">{children}</dd>
    </div>
  )
}

interface SummaryPanelProps extends Pick<PanelProps, 'status' | 'error' | 'onRetry' | 'updatedAt'> {
  item: ServerListItem | undefined
  nowMs: number
  /** The history behind the sparklines, once it has loaded. Until then each keeps its place, empty. */
  series?: ServerSeries
  /** The history could not be refreshed or is older than the stale threshold: its newest sample is no longer "now". */
  seriesStale?: boolean
  className?: string
}

/**
 * [1] Summary: the latest reading of one server. Offline, or when the reading is stale, the
 * same meters show the last reading received, labelled as such, because "it was at 92% disk
 * when it went quiet" is exactly what an operator needs to know.
 * Each meter has its history beside it, from the series the history panel draws.
 */
export function SummaryPanel({
  item,
  nowMs,
  series,
  seriesStale = false,
  className,
  ...data
}: SummaryPanelProps) {
  const { tz } = usePrefs()
  const server = item?.server
  const telemetry = server?.telemetry ?? null
  // Only a current reading is the present value; offline, stale or missing, the meters show the last one.
  const live = item !== undefined && reportsLoad(item)
  const clock = (iso: string) => formatClock(Date.parse(iso), tz)
  const memoryUsed = telemetry ? (telemetry.memoryTotalBytes * telemetry.memoryPercent) / 100 : null
  const diskUsed = telemetry ? (telemetry.diskTotalBytes * telemetry.diskPercent) / 100 : null

  return (
    <Panel
      index={1}
      title="Summary"
      features="servers"
      scope={telemetry && !live ? 'LAST READING' : 'NOW'}
      className={className}
      {...data}
      skeleton={<div className="h-28" />}
    >
      {server && item ? (
        <div className="flex flex-col gap-3">
          {telemetry ? (
            <div className="grid gap-x-6 gap-y-2 lg:grid-cols-3">
              {(
                [
                  ['cpu', 'CPU', telemetry.cpuPercent, null],
                  [
                    'memory',
                    'RAM',
                    telemetry.memoryPercent,
                    `${formatBytes(memoryUsed)} of ${formatBytes(telemetry.memoryTotalBytes, 0)}`,
                  ],
                  [
                    'disk',
                    'Disk',
                    telemetry.diskPercent,
                    `${formatBytes(diskUsed)} of ${formatBytes(telemetry.diskTotalBytes, 0)}`,
                  ],
                ] as const
              ).map(([id, label, percent, detail]) => (
                <div key={id} className="flex flex-col gap-1">
                  <span className="type-label flex justify-between gap-2 text-fg-faint">
                    {label}
                    {detail ? <span className="type-data normal-case">{detail}</span> : null}
                  </span>
                  {/* Right of the meter; wraps under it rather than squeezing it below 12rem. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <CellMeter
                      percent={percent}
                      label={`${label} of ${server.name}`}
                      className="min-w-0 grow basis-48"
                    />
                    {series ? (
                      <Sparkline
                        values={valuesOf(series, id)}
                        times={series.t}
                        tz={tz}
                        label={historyLabel(label, server.name, series)}
                        inspectable
                        stale={seriesStale}
                      />
                    ) : (
                      <span aria-hidden="true" className="h-6 w-16 shrink-0" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="type-body text-fg-muted">
              {server.lastSeenAt
                ? 'The agent reports, but no resource reading has arrived yet, so there is nothing to show.'
                : 'This server is enrolled but its agent has not sent a heartbeat yet, so there is nothing to show.'}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
            <Fact label="Uptime">{uptimeText(item)}</Fact>
            <Fact label="Last heartbeat">
              {server.lastSeenAt ? (
                <span title={clock(server.lastSeenAt)}>{heartbeatText(item, nowMs)}</span>
              ) : (
                'never'
              )}
            </Fact>
            <Fact label="Agent">{server.agentVersion ? `v${server.agentVersion}` : EMPTY}</Fact>
            <Fact label="Containers">{item.containers.total}</Fact>
          </dl>
        </div>
      ) : null}
    </Panel>
  )
}
