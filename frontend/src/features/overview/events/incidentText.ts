import type { RangeKey } from '@/api/types'
import {
  EMPTY,
  formatClock,
  formatQuantity,
  formatTime,
  timezoneLabel,
  type Timezone,
} from '@/lib/format'
import type { Axis, Incident, IncidentCounts } from './incidentModel'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The calendar day an instant falls on in the operator's timezone: its weekday, and a key that is equal for instants of the same day. */
function calendarDay(ms: number, tz: Timezone) {
  const date = new Date(ms)
  return tz === 'utc'
    ? { weekday: date.getUTCDay(), key: Math.floor(ms / DAY) }
    : {
        weekday: date.getDay(),
        key: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
      }
}

/**
 * Whether the axis runs across midnight, so a bare HH:mm could be either of two days. Every time
 * written against such an axis leads with its weekday.
 */
export const spansDays = (axis: Axis, tz: Timezone) =>
  calendarDay(axis.start, tz).key !== calendarDay(axis.end, tz).key

/** formatClock led by the weekday in three letters: "Tue 21:07Z". */
export function dayClockOf(ms: number, tz: Timezone, seconds = false): string {
  const weekday = WEEKDAYS[calendarDay(ms, tz).weekday] as string
  return `${weekday.slice(0, 3)} ${formatClock(ms, tz, seconds)}`
}

/** The time as a screen reader gets it: HH:mm, led by the weekday spelled out when the axis crosses midnight. */
function spokenClock(ms: number, tz: Timezone, dated: boolean): string {
  const clock = formatTime(ms, tz, false)
  return dated ? `${WEEKDAYS[calendarDay(ms, tz).weekday]} ${clock}` : clock
}

/** "28m", "1h 5m", "2h", "1d 3h": the two most significant units, minutes at the finest. */
export function compactDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 1) return '<1m'
  if (ms < HOUR) return `${minutes}m`
  const hours = Math.floor(ms / HOUR)
  if (ms < DAY) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(ms / DAY)
  const rest = Math.floor((ms % DAY) / HOUR)
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`
}

/** "28 minutes", "1 hour 5 minutes": compactDuration spelled out for a screen reader. */
export function spokenDuration(ms: number): string {
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 1) return 'less than a minute'
  if (ms < HOUR) return formatQuantity(minutes, 'minute')
  const hours = Math.floor(ms / HOUR)
  if (ms < DAY)
    return minutes % 60 === 0
      ? formatQuantity(hours, 'hour')
      : `${formatQuantity(hours, 'hour')} ${formatQuantity(minutes % 60, 'minute')}`
  const days = Math.floor(ms / DAY)
  const rest = Math.floor((ms % DAY) / HOUR)
  return rest === 0
    ? formatQuantity(days, 'day')
    : `${formatQuantity(days, 'day')} ${formatQuantity(rest, 'hour')}`
}

/** The range as it follows "the last": "hour", "6 hours". */
const RANGE_SPOKEN: Record<RangeKey, string> = {
  '15m': '15 minutes',
  '1h': 'hour',
  '6h': '6 hours',
  '24h': '24 hours',
}

/** What the line above the lanes says; `truncated` adds that older events were not read. */
export const summaryText = ({ ongoing, resolved }: IncidentCounts, truncated = false) =>
  `${ongoing} ongoing · ${resolved} resolved${truncated ? ' · newest events only' : ''}`

export const emptyText = (range: RangeKey, truncated = false) =>
  truncated
    ? `No incidents among the newest events of the last ${range}`
    : `No incidents in the last ${range}`

/**
 * What the axis covers, for the list that sits on it: the window, its ends, and
 * the timezone every time in the lanes' names is in. An axis that runs across midnight
 * names the weekday of each end.
 */
export function timelineDescription(axis: Axis, range: RangeKey, tz: Timezone): string {
  const dated = spansDays(axis, tz)
  return `Last ${RANGE_SPOKEN[range]}, ${spokenClock(axis.start, tz, dated)} to ${spokenClock(axis.end, tz, dated)}. Times are ${timezoneLabel(tz)}.`
}

/**
 * The lane as one sentence: "pir-vpn: critical incident, started 15:32, ongoing for 22 minutes".
 * An incident without an opening has no start to give, and says why: it is older than the range,
 * or the events shown do not reach back to it. `dated` leads each time with its weekday.
 */
export function incidentName(
  incident: Incident,
  tz: Timezone,
  range: RangeKey,
  dated = false,
): string {
  const { subject, recovery, start, durationMs, missingOpening } = incident
  const clock = (ms: number) => spokenClock(ms, tz, dated)
  const parts: string[] = []
  if (start === null) {
    parts.push(
      missingOpening === 'not-shown'
        ? `${subject.name}: incident whose opening is not among the events shown`
        : `${subject.name}: incident that began before the last ${RANGE_SPOKEN[range]}`,
    )
    if (recovery) parts.push(`resolved at ${clock(recovery.at)}`)
  } else {
    parts.push(`${subject.name}: ${incident.severity} incident`, `started ${clock(start)}`)
    const spoken = spokenDuration(durationMs ?? 0)
    parts.push(
      recovery ? `resolved after ${spoken} at ${clock(recovery.at)}` : `ongoing for ${spoken}`,
    )
  }
  return parts.join(', ')
}

export interface IncidentFact {
  label: string
  value: string
}

/** What the tooltip lists: when, how long, how bad, and the two messages. `dated` leads each time with its weekday. */
export function incidentFacts(
  incident: Incident,
  tz: Timezone,
  range: RangeKey,
  dated = false,
): IncidentFact[] {
  const { start, recovery, durationMs, missingOpening } = incident
  const clock = (ms: number) => (dated ? dayClockOf(ms, tz, true) : formatClock(ms, tz, true))
  const unknownStart =
    missingOpening === 'not-shown' ? 'not in the events shown' : `before the last ${range}`
  const facts: IncidentFact[] = [
    { label: 'Severity', value: incident.severity ?? 'not known' },
    { label: 'Started', value: start === null ? unknownStart : clock(start) },
    { label: 'Recovered', value: recovery ? clock(recovery.at) : 'ongoing' },
    {
      label: 'Duration',
      value:
        durationMs === null ? EMPTY : `${compactDuration(durationMs)}${recovery ? '' : ' so far'}`,
    },
  ]
  if (incident.message !== null) facts.push({ label: 'Opening', value: incident.message })
  if (recovery) facts.push({ label: 'Recovery', value: recovery.message })
  return facts
}
