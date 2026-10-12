import type { ServerListItem } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { EMPTY, formatBytes, formatTime } from '@/lib/format'
import { Panel, type PanelProps } from '@/ui/Panel'
import { CellMeter } from '@/ui/meters'
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
  className?: string
}

/**
 * [1] Summary: the latest reading of one server. Offline, the same meters show
 * the last reading before the agent stopped, labelled as such, because "it was
 * at 92% disk when it went quiet" is exactly what an operator needs to know.
 */
export function SummaryPanel({ item, nowMs, className, ...data }: SummaryPanelProps) {
  const { tz } = usePrefs()
  const server = item?.server
  const telemetry = server?.telemetry ?? null
  const live = server?.status === 'online' || server?.status === 'warning'
  const clock = (iso: string) => `${formatTime(Date.parse(iso), tz)}${tz === 'utc' ? 'Z' : ''}`
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
                  ['CPU', telemetry.cpuPercent, null],
                  [
                    'RAM',
                    telemetry.memoryPercent,
                    `${formatBytes(memoryUsed)} of ${formatBytes(telemetry.memoryTotalBytes, 0)}`,
                  ],
                  [
                    'Disk',
                    telemetry.diskPercent,
                    `${formatBytes(diskUsed)} of ${formatBytes(telemetry.diskTotalBytes, 0)}`,
                  ],
                ] as const
              ).map(([label, percent, detail]) => (
                <div key={label} className="flex flex-col gap-1">
                  <span className="type-label flex justify-between gap-2 text-fg-faint">
                    {label}
                    {detail ? <span className="type-data normal-case">{detail}</span> : null}
                  </span>
                  <CellMeter percent={percent} label={`${label} of ${server.name}`} />
                </div>
              ))}
            </div>
          ) : (
            <p className="type-body text-fg-muted">
              This server is enrolled but its agent has not sent a heartbeat yet, so there is
              nothing to show.
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
