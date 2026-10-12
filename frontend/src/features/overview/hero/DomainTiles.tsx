import type { OverviewSummary, StatusCounts } from '@/api/types'
import type { FeatureId } from '@/config/features'
import type { NavItem } from '@/config/nav'
import { formatInteger } from '@/lib/format'
import { SegmentedBar, Sparkline } from '@/ui/meters'
import { CountList } from './CountList'
import { useSummaryState } from './fleetStatus'
import { StatTile, type TileContent } from './StatTile'
import { PROBLEM_STATUSES, describeDomain, navPath, type DomainFigures } from './tileText'

interface TileProps {
  /** Grid placement from the strip. */
  className?: string
}

interface DomainTileConfig {
  label: string
  features: FeatureId
  route: NavItem['id']
  /** What "up" means for this domain: online, running, up. */
  word: string
  pick: (summary: OverviewSummary) => DomainFigures
  /** A sparkline of the domain's history, where the backend stores one. */
  trend?: { label: string; values: (summary: OverviewSummary) => readonly number[] }
}

/**
 * A listed count line: problems only ("2 WARN 1 CRIT"), or the OK count when
 * there are none. Three statuses would not fit a 171px tile with their words,
 * so then the shape and number stay and the link's name carries the words.
 */
function DomainCounts({ counts }: { counts: StatusCounts }) {
  const problems = PROBLEM_STATUSES.filter((status) => counts[status] > 0)
  return (
    <CountList
      counts={counts}
      show={problems.length > 0 ? PROBLEM_STATUSES : ['healthy']}
      words={problems.length < 3}
      empty="none monitored"
    />
  )
}

/**
 * Counts, denominators and bars come only from the shared summary: the same
 * numbers feed the verdict and the sidebar badges, so they cannot disagree.
 */
function DomainTile({
  label,
  features,
  route,
  word,
  pick,
  trend,
  className,
}: DomainTileConfig & TileProps) {
  const { summary, stale } = useSummaryState()
  const { data } = summary

  let content: TileContent | undefined
  if (data) {
    const figures = pick(data)
    content = {
      summary: describeDomain(figures, word),
      value: figures.value,
      unit: `/${formatInteger(figures.total)} ${word}`,
      detail: <DomainCounts counts={figures.counts} />,
      bar: <SegmentedBar counts={figures.counts} height={6} label={label} className="w-full" />,
      trend: trend ? <Sparkline values={trend.values(data)} label={trend.label} /> : undefined,
    }
  }

  return (
    <StatTile
      label={label}
      features={features}
      to={navPath(route)}
      status={summary.status}
      content={content}
      stale={stale}
      onRetry={summary.refetch}
      className={className}
    />
  )
}

export function ServersTile({ className }: TileProps) {
  return (
    <DomainTile
      label="Servers"
      features="servers"
      route="servers"
      word="online"
      pick={({ servers }) => ({
        value: servers.online,
        total: servers.total,
        counts: servers.counts,
      })}
      className={className}
    />
  )
}

export function ContainersTile({ className }: TileProps) {
  return (
    <DomainTile
      label="Containers"
      features="docker"
      route="docker"
      word="running"
      pick={({ containers }) => ({
        value: containers.running,
        total: containers.total,
        counts: containers.counts,
      })}
      className={className}
    />
  )
}

/** The only tile with a trend: probe history exists, so the hour's success rate is real. */
export function TargetsTile({ className }: TileProps) {
  return (
    <DomainTile
      label="Net targets"
      features="network"
      route="network"
      word="up"
      pick={({ targets }) => ({ value: targets.up, total: targets.total, counts: targets.counts })}
      trend={{ label: 'Success rate, last hour', values: ({ targets }) => targets.successTrend }}
      className={className}
    />
  )
}
