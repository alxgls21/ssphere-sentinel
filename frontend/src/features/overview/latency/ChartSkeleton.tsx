import { BASE_ROOT_PX } from '@/charts/theme'
import { Skeleton } from '@/ui/states'
import { LATENCY_CHART_HEIGHT_PX, LATENCY_GEOMETRY } from './latencyGeometry'

/** Legend row above the plot, px at the 16px root. */
const LEGEND_ROW_PX = 24

/** Legend row plus plot: the height the panel body keeps in every state, so nothing shifts. */
const LATENCY_BODY_PX = LEGEND_ROW_PX + LATENCY_CHART_HEIGHT_PX

const rem = (px: number) => `${px / BASE_ROOT_PX}rem`

const g = LATENCY_GEOMETRY
const latencyTop = LEGEND_ROW_PX + g.top
const lossTop = latencyTop + g.latency + g.gap

/** Hairlines where the real gridlines will be: four in the latency grid, top and baseline of the loss grid. */
const GHOST_LINES = [
  ...[0, 1, 2, 3].map((step) => latencyTop + (g.latency / 3) * step),
  lossTop,
  lossTop + g.loss,
]

interface ChartSkeletonProps {
  /** One pulsing placeholder line: the loading state. The empty state keeps just the axes. */
  line?: boolean
}

/** Ghost axes in border color, at the real grid positions, so loading and empty keep the chart's frame. */
export function ChartSkeleton({ line = true }: ChartSkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className="relative min-h-0 flex-1"
      style={{ minHeight: rem(LATENCY_BODY_PX) }}
    >
      {GHOST_LINES.map((top) => (
        <div
          key={top}
          className="absolute border-t border-border"
          style={{ top: rem(top), left: rem(g.left), right: rem(g.right) }}
        />
      ))}
      {line ? (
        <div
          className="absolute"
          style={{ top: rem(latencyTop + 60), left: rem(g.left + 8), right: rem(g.right + 48) }}
        >
          <Skeleton className="h-0.5" />
        </div>
      ) : null}
    </div>
  )
}
