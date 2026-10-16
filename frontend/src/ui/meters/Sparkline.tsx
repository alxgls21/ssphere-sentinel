import type { Timezone } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/controls'
import {
  SPARK_HEIGHT,
  SPARK_WIDTH,
  TAIL_Y,
  describeSeries,
  seriesFigures,
  sparklinePoints,
  sparklineRuns,
  trailingGap,
  type Sample,
} from './geometry'

const PERCENT_DOMAIN = [0, 100] as const

interface SparklineProps {
  /**
   * Oldest first, one per bucket; null where a bucket held no sample. A gap
   * breaks the line instead of being closed. Fewer than 2 samples draw no line.
   */
  values: readonly Sample[]
  /** Start of each bucket, epoch ms. With it the figures say when. */
  times?: readonly number[]
  /** The clock `times` are written in. */
  tz?: Timezone
  /** Fixed scale, so a flat 98-100% hour reads as flat instead of being stretched. */
  domain?: readonly [min: number, max: number]
  /** Accessible-name prefix: "Success rate last hour". */
  label: string
  /** Unit spoken in the accessible name. */
  unit?: string
  /**
   * One tab stop that opens the figures behind the line, as the pointer does on
   * hover. Off where the sparkline sits inside a link or button, which already
   * carries the numbers and must not hold a second control.
   */
  inspectable?: boolean
  /**
   * The series is no longer being refreshed, so its newest sample is the last one received, not the
   * current one: the end mark is hollow and the figures say "last" where they would say "now".
   */
  stale?: boolean
  className?: string
}

/**
 * A 64x24 trend line: no axes. The last point is an 8px primary dot with a 2px
 * ring in the panel color so it stays legible where it crosses the line, and
 * only a real newest sample gets it. A missing sample leaves a gap (a lone
 * sample between gaps is a dot), and a series that ends on a gap shows a hollow
 * mark on its last sample and a dashed tail under the scale, so the silence is
 * drawn rather than filled in. A stale series ends in the same hollow mark.
 * Only for series the backend really stores: with no history it says so
 * instead of drawing one.
 */
export function Sparkline({
  values,
  times,
  tz = 'utc',
  domain = PERCENT_DOMAIN,
  label,
  unit = 'percent',
  inspectable = false,
  stale = false,
  className,
}: SparklineProps) {
  const points = sparklinePoints(values, domain)
  const drawn = points.length > 0
  const end = points.at(-1) ?? null
  const gap = trailingGap(points)
  const clock = times ? { times, tz } : undefined
  const figures = inspectable ? seriesFigures(values, unit, clock, stale) : null

  const image = (
    <span
      // A drawing has no element of its own: role=img, named with the figures behind the line.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="img"
      aria-label={describeSeries(label, values, unit, clock, stale)}
      // Read, not operated: the stop exists so the figures a pointer gets on hover reach the keyboard.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={figures ? 0 : undefined}
      className={cn(
        'inline-flex h-6 w-16 shrink-0 items-center justify-center rounded-sm',
        className,
      )}
    >
      {drawn ? (
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          className="h-6 w-16 shrink-0 overflow-visible"
        >
          {sparklineRuns(points).map((run) => {
            const [first] = run
            if (!first) return null
            if (run.length === 1) {
              return first === end ? null : (
                <circle
                  key={first[0]}
                  cx={first[0]}
                  cy={first[1]}
                  r={1.5}
                  className="fill-series-other"
                />
              )
            }
            const path = run.map(([x, y]) => `${x},${y}`).join(' ')
            return (
              <polyline
                key={path}
                points={path}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                className="stroke-series-other"
              />
            )
          })}
          {gap ? (
            <>
              <path
                d={`M${gap.from[0]} ${TAIL_Y}H${gap.toX}`}
                fill="none"
                strokeWidth={1}
                strokeDasharray="2 2"
                className="stroke-fg-faint"
              />
              <circle
                cx={gap.from[0]}
                cy={gap.from[1]}
                r={3}
                strokeWidth={1.5}
                className="fill-panel stroke-fg-muted"
              />
            </>
          ) : null}
          {end && stale ? (
            <circle
              cx={end[0]}
              cy={end[1]}
              r={3}
              strokeWidth={1.5}
              className="fill-panel stroke-fg-muted"
            />
          ) : null}
          {end && !stale ? (
            <>
              <circle cx={end[0]} cy={end[1]} r={5} className="fill-panel" />
              <circle cx={end[0]} cy={end[1]} r={4} className="fill-primary" />
            </>
          ) : null}
        </svg>
      ) : (
        <span className="flex flex-col items-center gap-0.5">
          <span className="h-0.5 w-4 rounded-sm bg-fg-faint" />
          <span className="type-chart whitespace-nowrap text-fg-faint">no history</span>
        </span>
      )}
    </span>
  )

  if (!figures) return image
  return (
    <Tooltip
      content={
        <span className="flex flex-col">
          <span className="type-data-strong">{label}</span>
          {figures.map((figure) => (
            <span key={figure}>{figure}</span>
          ))}
        </span>
      }
    >
      {image}
    </Tooltip>
  )
}
