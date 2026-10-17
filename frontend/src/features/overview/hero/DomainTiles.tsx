import type { OverviewSummary, StatusCounts } from '@/api/types'
import type { FeatureId } from '@/config/features'
import type { NavItem } from '@/config/nav'
import { formatInteger } from '@/lib/format'
import { SegmentedBar } from '@/ui/meters'
import { CountList } from './CountList'
import { useSummaryState } from './fleetStatus'
import { StatTile, type TileContent } from './StatTile'
import {
  PROBLEM_STATUSES,
  describeDomain,
  listedCounts,
  navPath,
  type DomainFigures,
} from './tileText'

interface TileProps {
  /** Grid placement from the strip. */
  className?: string
}

interface DomainTileConfig {
  label: string
  features: FeatureId | readonly FeatureId[]
  route: NavItem['id']
  /** What the headline counts: the healthy ones, "ok". */
  word: string
  pick: (summary: OverviewSummary) => DomainFigures
}

/**
 * A listed count line: problems only ("1 CRIT 2 WARN"), or the OK count when
 * there are none. Offline servers count as a problem of their own, so a line
 * can hold one more mark. Three marks would not fit a 171px tile with their
 * words, so then the shape and number stay and the link's name carries the words.
 */
function DomainCounts({ counts }: { counts: StatusCounts }) {
  const problems = listedCounts(counts, PROBLEM_STATUSES)
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
      features={['servers', 'overview']}
      route="servers"
      word="ok"
      pick={({ servers }) => ({
        value: servers.counts.healthy,
        total: servers.total,
        counts: servers.counts,
      })}
      className={className}
    />
  )
}

export function TargetsTile({ className }: TileProps) {
  return (
    <DomainTile
      label="Net targets"
      features={['network', 'overview']}
      route="network"
      word="ok"
      pick={({ targets }) => ({
        value: targets.counts.healthy,
        total: targets.total,
        counts: targets.counts,
      })}
      className={className}
    />
  )
}

export function ContainersTile({ className }: TileProps) {
  return (
    <DomainTile
      label="Containers"
      features="overview"
      route="docker"
      word="ok"
      pick={({ containers }) => ({
        value: containers.counts.healthy,
        total: containers.total,
        counts: containers.counts,
      })}
      className={className}
    />
  )
}
