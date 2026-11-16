import type { ServerListSeries } from '@/api/types'
import type { Timezone } from '@/lib/format'
import { RANGE_WORDS } from '@/lib/range'
import { Sparkline } from '@/ui/meters'

const NAME = { cpu: 'CPU', memory: 'RAM', disk: 'Disk' } as const

export type TrendMetric = keyof typeof NAME

/**
 * The history of one resource of one server, from the page's series, as a sparkline. Nothing where the
 * answer holds no row for this server: a trend is never made up.
 */
export function LoadTrend({
  trends,
  serverId,
  serverName,
  metric,
  tz,
  stale,
  className,
}: {
  trends: ServerListSeries | undefined
  serverId: string
  serverName: string
  metric: TrendMetric
  tz: Timezone
  stale: boolean
  className?: string
}) {
  const row = trends?.items.find((entry) => entry.serverId === serverId)
  if (!trends || !row) return null
  return (
    <Sparkline
      values={row[metric]}
      times={trends.t}
      tz={tz}
      stale={stale}
      label={`${NAME[metric]} of ${serverName}, ${RANGE_WORDS[trends.range]}`}
      className={className}
    />
  )
}
