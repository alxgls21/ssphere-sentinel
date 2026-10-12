import { cn } from '@/lib/cn'
import { SPARK_HEIGHT, SPARK_WIDTH, describeSeries, sparklinePoints } from './geometry'

const PERCENT_DOMAIN = [0, 100] as const

interface SparklineProps {
  /** Oldest first. The caller supplies 12 points; fewer than 2 draws no line. */
  values: readonly number[]
  /** Fixed scale, so a flat 98-100% hour reads as flat instead of being stretched. */
  domain?: readonly [min: number, max: number]
  /** Accessible-name prefix: "Success rate last hour". */
  label: string
  /** Unit spoken in the accessible name. */
  unit?: string
  className?: string
}

/**
 * A 64x24 trend line: no axes, no tooltip (the text beside it carries the
 * number). The last point is an 8px primary dot with a 2px ring in the panel
 * color so it stays legible where it crosses the line. Only for series the
 * backend really stores: with no history it says so instead of drawing one.
 */
export function Sparkline({
  values,
  domain = PERCENT_DOMAIN,
  label,
  unit = 'percent',
  className,
}: SparklineProps) {
  const points = sparklinePoints(values, domain)
  const last = points.at(-1)

  return (
    <span
      // A drawing has no element of its own: role=img, named with the figures behind the line.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="img"
      aria-label={describeSeries(label, values, unit)}
      className={cn('inline-flex h-6 min-w-16 shrink-0 items-center justify-center', className)}
    >
      {last ? (
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          className="h-6 w-16 shrink-0"
        >
          <polyline
            points={points.map(([x, y]) => `${x},${y}`).join(' ')}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            className="stroke-series-other"
          />
          <circle cx={last[0]} cy={last[1]} r={5} className="fill-panel" />
          <circle cx={last[0]} cy={last[1]} r={4} className="fill-primary" />
        </svg>
      ) : (
        <span className="flex flex-col items-center gap-0.5">
          <span className="h-0.5 w-4 rounded-sm bg-fg-faint" />
          <span className="type-chart whitespace-nowrap text-fg-faint">no history</span>
        </span>
      )}
    </span>
  )
}
