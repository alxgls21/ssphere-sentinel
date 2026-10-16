/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions --
   A lane is read, not operated. It is focusable anyway so a keyboard user can stop the timeline
   (focus pauses it), open the tooltip a pointer gets on hover, and walk the lanes with the arrow
   keys that the timeline wires up. */
import type { KeyboardEventHandler, Ref } from 'react'
import type { RangeKey } from '@/api/types'
import { cn } from '@/lib/cn'
import { EMPTY, type Timezone } from '@/lib/format'
import { Tooltip } from '@/ui/controls'
import { STATUS_EDGE, STATUS_FRAME, STATUS_TEXT, STATUS_TINT, StatusGlyph } from '@/ui/status'
import type { Incident, Span } from './incidentModel'
import { compactDuration, incidentFacts, incidentName } from './incidentText'

/**
 * The columns of a lane: who, the time axis, and how it ended. The axis row above the
 * lanes uses the same ones, so a bar sits under the times it is measured against. A wide
 * panel gives the name room for an interface and its host ("Gi1/0/15@ath-core-sw1"); a
 * narrower one cuts the end of a long name, whole in the tooltip and in the lane's label.
 */
export const LANE_COLUMNS =
  'grid grid-cols-[7.5rem_minmax(0,1fr)_6.75rem] gap-x-2 @max-sm:grid-cols-[4rem_minmax(0,1fr)_6.75rem] @lg:grid-cols-[10rem_minmax(0,1fr)_6.75rem]'

/**
 * The stretch of the track that is the axis. The room around it holds the marks that sit
 * outside a bar's ends: the severity mark and the cut-off chevron on the left (20px), the
 * recovery mark or the open end on the right (12px).
 */
export const AXIS_BOX = 'absolute inset-y-0 right-3 left-5'

const percent = (fraction: number) => `${+(fraction * 100).toFixed(2)}%`

/** An open end: the bar goes on past this edge. A stroke, so it keeps its shape in forced colors. */
function Chevron({ direction, className }: { direction: 'left' | 'right'; className: string }) {
  return (
    <svg
      viewBox="0 0 6 10"
      aria-hidden="true"
      focusable="false"
      data-part={direction === 'right' ? 'open-end' : 'cut-off'}
      className={cn('inline-block h-2.5 w-1.5 shrink-0', className)}
    >
      <path
        d={direction === 'right' ? 'M1 1L5 5L1 9' : 'M5 1L1 5L5 9'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The incident drawn against the axis, left to right: a mark for how it began, a bar for how long it
 * lasted, and a mark for how it ended. An ongoing incident is a solid bar that runs to the right
 * edge and stays open (a chevron); a resolved one is a thin line on a tint that ends in the OK mark.
 */
function Track({ incident, span }: { incident: Incident; span: Span }) {
  const ongoing = incident.status === 'ongoing'
  const tone = incident.severity ?? 'unknown'
  return (
    <span aria-hidden="true" className="relative block self-stretch">
      <span className={cn(AXIS_BOX, 'border-x border-border')}>
        <span
          data-part="bar"
          className={cn(
            'absolute top-1/2 h-2 min-w-0.5 -translate-y-1/2',
            ongoing ? STATUS_EDGE[tone] : cn('border', STATUS_TINT[tone], STATUS_FRAME[tone]),
          )}
          style={{ left: percent(span.from), width: percent(span.to - span.from) }}
        >
          {ongoing ? null : (
            <span
              className={cn('absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2', STATUS_EDGE[tone])}
            />
          )}
        </span>
        <span
          className="absolute top-1/2 flex -translate-x-full -translate-y-1/2 items-center gap-0.5 pr-0.5"
          style={{ left: percent(span.from) }}
        >
          {span.clipped ? <Chevron direction="left" className={STATUS_TEXT[tone]} /> : null}
          {incident.severity ? <StatusGlyph status={incident.severity} size={10} /> : null}
        </span>
        <span
          className="absolute top-1/2 -translate-y-1/2 pl-0.5"
          style={{ left: percent(ongoing ? 1 : span.to) }}
        >
          {ongoing ? (
            <Chevron direction="right" className={STATUS_TEXT[tone]} />
          ) : (
            <StatusGlyph status="healthy" size={10} />
          )}
        </span>
      </span>
    </span>
  )
}

interface IncidentLaneProps {
  incident: Incident
  span: Span
  range: RangeKey
  tz: Timezone
  /** The axis runs across midnight, so each time leads with its weekday. */
  dated: boolean
  tabIndex: 0 | -1
  ref: Ref<HTMLLIElement>
  onFocus: () => void
  onKeyDown: KeyboardEventHandler<HTMLLIElement>
}

/**
 * A 24px lane, the log's line height: the subject, the incident on the axis, and the
 * word for how it stands (ONGOING or RESOLVED) with its duration. The whole lane is named
 * by one sentence; the tooltip lists the times and both messages.
 */
export function IncidentLane({
  incident,
  span,
  range,
  tz,
  dated,
  tabIndex,
  ref,
  onFocus,
  onKeyDown,
}: IncidentLaneProps) {
  const ongoing = incident.status === 'ongoing'
  const tone = incident.severity ?? 'unknown'
  return (
    <Tooltip
      content={
        <dl>
          {incidentFacts(incident, tz, range, dated).map(({ label, value }) => (
            <div key={label} className="flex gap-3">
              <dt className="w-[12ch] shrink-0 text-fg-faint">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
      }
    >
      <li
        ref={ref}
        tabIndex={tabIndex}
        aria-label={incidentName(incident, tz, range, dated)}
        data-incident={incident.status}
        data-clipped={span.clipped || undefined}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className={cn(
          LANE_COLUMNS,
          'h-6 items-center px-3 transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:-outline-offset-2',
        )}
      >
        <span className="type-data truncate">{incident.subject.name}</span>
        <Track incident={incident} span={span} />
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className={cn('type-tag', ongoing ? STATUS_TEXT[tone] : 'text-fg-muted')}>
            {ongoing ? 'ONGOING' : 'RESOLVED'}
          </span>
          <span className="type-data tnum">
            {incident.durationMs === null ? EMPTY : compactDuration(incident.durationMs)}
          </span>
        </span>
      </li>
    </Tooltip>
  )
}
