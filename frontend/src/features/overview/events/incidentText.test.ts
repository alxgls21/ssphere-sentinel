import { describe, expect, it } from 'vitest'
import type { EventLevel, SentinelEvent } from '@/api/types'
import { formatTime } from '@/lib/format'
import { axisOf, buildIncidents, type Incident } from './incidentModel'
import {
  compactDuration,
  dayClockOf,
  emptyText,
  incidentFacts,
  incidentName,
  spansDays,
  spokenDuration,
  summaryText,
  timelineDescription,
} from './incidentText'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const at = (hms: string) => `2026-10-12T${hms}Z`
const ms = (hms: string) => Date.parse(at(hms))
const NOW = ms('15:00:00')

const event = (
  id: string,
  time: string,
  level: EventLevel,
  parentId?: string,
  subject = 'pir-vpn',
): SentinelEvent => ({
  id,
  at: at(time),
  level,
  subject: { kind: 'target', id: subject, name: subject },
  message: `${id} message`,
  ...(parentId ? { parentId } : {}),
})

const incidentOf = (events: SentinelEvent[]): Incident => buildIncidents(events, NOW)[0] as Incident

describe('compactDuration', () => {
  it.each([
    [0, '<1m'],
    [59_999, '<1m'],
    [MINUTE, '1m'],
    [28 * MINUTE, '28m'],
    [59 * MINUTE + 59_999, '59m'],
    [HOUR, '1h'],
    [HOUR + MINUTE, '1h 1m'],
    [2 * HOUR, '2h'],
    [23 * HOUR + 59 * MINUTE, '23h 59m'],
    [24 * HOUR, '1d'],
    [27 * HOUR, '1d 3h'],
  ])('writes %i ms as %s', (duration, text) => {
    expect(compactDuration(duration)).toBe(text)
  })
})

describe('spokenDuration', () => {
  it.each([
    [0, 'less than a minute'],
    [59_999, 'less than a minute'],
    [MINUTE, '1 minute'],
    [22 * MINUTE, '22 minutes'],
    [HOUR, '1 hour'],
    [HOUR + 5 * MINUTE, '1 hour 5 minutes'],
    [2 * HOUR + MINUTE, '2 hours 1 minute'],
    [24 * HOUR, '1 day'],
    [51 * HOUR, '2 days 3 hours'],
  ])('says %i ms as %s', (duration, text) => {
    expect(spokenDuration(duration)).toBe(text)
  })
})

describe('dayClockOf', () => {
  it('leads the clock with the weekday, in UTC and with seconds on request', () => {
    // 2026-10-12 is a Monday.
    expect(dayClockOf(ms('15:32:07'), 'utc')).toBe('Mon 15:32Z')
    expect(dayClockOf(ms('15:32:07'), 'utc', true)).toBe('Mon 15:32:07Z')
    expect(dayClockOf(ms('15:32:07') - 24 * HOUR, 'utc')).toBe('Sun 15:32Z')
  })

  it('names the day the instant falls on in the operator timezone', () => {
    const local = new Date(ms('15:32:07'))
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local.getDay()]
    expect(dayClockOf(ms('15:32:07'), 'local')).toBe(
      `${weekday} ${formatTime(ms('15:32:07'), 'local', false)}`,
    )
  })
})

describe('spansDays', () => {
  it('is true for a 24 hour axis, whatever the time of day', () => {
    expect(spansDays(axisOf(NOW, '24h'), 'utc')).toBe(true)
    expect(spansDays(axisOf(ms('00:00:00'), '24h'), 'utc')).toBe(true)
  })

  it('is false while the whole window is on one day', () => {
    expect(spansDays(axisOf(NOW, '1h'), 'utc')).toBe(false)
    expect(spansDays(axisOf(NOW, '6h'), 'utc')).toBe(false)
    expect(spansDays(axisOf(ms('01:00:00'), '1h'), 'utc')).toBe(false)
  })

  it('is true once the window reaches back across midnight', () => {
    expect(spansDays(axisOf(ms('00:20:00'), '1h'), 'utc')).toBe(true)
    expect(spansDays(axisOf(ms('02:00:00'), '6h'), 'utc')).toBe(true)
  })

  it('reads the days in the operator timezone', () => {
    const axis = axisOf(NOW, '24h')
    expect(spansDays(axis, 'local')).toBe(true)
  })
})

describe('summary and empty text', () => {
  it('counts both kinds, even at zero', () => {
    expect(summaryText({ ongoing: 2, resolved: 5 })).toBe('2 ongoing · 5 resolved')
    expect(summaryText({ ongoing: 0, resolved: 1 })).toBe('0 ongoing · 1 resolved')
  })

  it('names the range in the empty line', () => {
    expect(emptyText('1h')).toBe('No incidents in the last 1h')
    expect(emptyText('24h')).toBe('No incidents in the last 24h')
  })

  it('says when only the newest events were read, instead of speaking for the whole range', () => {
    expect(summaryText({ ongoing: 2, resolved: 5 }, true)).toBe(
      '2 ongoing · 5 resolved · newest events only',
    )
    expect(emptyText('24h', true)).toBe('No incidents among the newest events of the last 24h')
  })
})

describe('timelineDescription', () => {
  it('says what the axis covers and in which timezone the lane names are written', () => {
    expect(timelineDescription(axisOf(NOW, '1h'), '1h', 'utc')).toBe(
      'Last hour, 14:00 to 15:00. Times are UTC.',
    )
    expect(timelineDescription(axisOf(NOW, '6h'), '6h', 'utc')).toBe(
      'Last 6 hours, 09:00 to 15:00. Times are UTC.',
    )
    expect(timelineDescription(axisOf(NOW, '15m'), '15m', 'local')).toMatch(
      /^Last 15 minutes, \d\d:\d\d to \d\d:\d\d\. Times are local\.$/,
    )
  })

  it('names the weekday of both ends when the axis runs across midnight, so the ends differ', () => {
    expect(timelineDescription(axisOf(NOW, '24h'), '24h', 'utc')).toBe(
      'Last 24 hours, Sunday 15:00 to Monday 15:00. Times are UTC.',
    )
    expect(timelineDescription(axisOf(ms('02:00:00'), '6h'), '6h', 'utc')).toBe(
      'Last 6 hours, Sunday 20:00 to Monday 02:00. Times are UTC.',
    )
  })
})

describe('incidentName', () => {
  it('is one sentence for an ongoing incident', () => {
    const incident = incidentOf([event('f', '14:38:00', 'critical')])
    expect(incidentName(incident, 'utc', '1h')).toBe(
      'pir-vpn: critical incident, started 14:38, ongoing for 22 minutes',
    )
  })

  it('is one sentence for a resolved incident, with how long it lasted and when it ended', () => {
    const incident = incidentOf([
      event('f', '14:03:00', 'warning', undefined, 'payments-api'),
      event('r', '14:31:00', 'healthy', 'f', 'payments-api'),
    ])
    expect(incidentName(incident, 'utc', '1h')).toBe(
      'payments-api: warning incident, started 14:03, resolved after 28 minutes at 14:31',
    )
  })

  it('does not say it was acknowledged, whatever info event is nested under it', () => {
    const incident = incidentOf([
      event('f', '14:38:00', 'critical'),
      event('ack', '14:40:00', 'info', 'f'),
    ])
    expect(incidentName(incident, 'utc', '1h')).toBe(
      'pir-vpn: critical incident, started 14:38, ongoing for 22 minutes',
    )
  })

  it('does not invent a start or a severity for an incident that began before the range', () => {
    const incident = incidentOf([event('r', '14:31:00', 'healthy', 'gone')])
    expect(incidentName(incident, 'utc', '1h')).toBe(
      'pir-vpn: incident that began before the last hour, resolved at 14:31',
    )
    expect(incidentName(incident, 'utc', '24h')).toContain('before the last 24 hours')
  })

  it('does not say it began before the range when the events only reach part of the way back', () => {
    const [incident] = buildIncidents([event('r', '14:31:00', 'healthy', 'gone')], NOW, true)
    expect(incidentName(incident as Incident, 'utc', '24h')).toBe(
      'pir-vpn: incident whose opening is not among the events shown, resolved at 14:31',
    )
  })

  it('leads each time with its weekday when the axis runs across midnight', () => {
    const yesterday = ms('21:07:00') - 24 * HOUR
    const incident = incidentOf([
      { ...event('f', '21:07:00', 'critical'), at: new Date(yesterday).toISOString() },
      {
        ...event('r', '21:37:00', 'healthy', 'f'),
        at: new Date(yesterday + 30 * MINUTE).toISOString(),
      },
    ])
    expect(incidentName(incident, 'utc', '24h', true)).toBe(
      'pir-vpn: critical incident, started Sunday 21:07, resolved after 30 minutes at Sunday 21:37',
    )
  })

  it('writes times in the chosen timezone', () => {
    const incident = incidentOf([event('f', '14:38:00', 'critical')])
    expect(incidentName(incident, 'local', '1h')).toContain(
      `started ${formatTime(ms('14:38:00'), 'local', false)},`,
    )
  })
})

describe('incidentFacts', () => {
  const facts = (incident: Incident, tz: 'utc' | 'local' = 'utc') =>
    Object.fromEntries(incidentFacts(incident, tz, '1h').map(({ label, value }) => [label, value]))

  it('lists the times, the duration, the severity and both messages for a resolved incident', () => {
    const incident = incidentOf([
      event('f', '14:03:10', 'warning'),
      event('r', '14:31:20', 'healthy', 'f'),
    ])
    expect(facts(incident)).toEqual({
      Severity: 'warning',
      Started: '14:03:10Z',
      Recovered: '14:31:20Z',
      Duration: '28m',
      Opening: 'f message',
      Recovery: 'r message',
    })
  })

  it('says ongoing, and how long so far, for one that has not recovered', () => {
    const incident = incidentOf([event('f', '14:38:00', 'critical')])
    expect(facts(incident)).toEqual({
      Severity: 'critical',
      Started: '14:38:00Z',
      Recovered: 'ongoing',
      Duration: '22m so far',
      Opening: 'f message',
    })
  })

  it('lists no acknowledgement fact', () => {
    const incident = incidentOf([
      event('f', '14:38:00', 'critical'),
      event('ack', '14:40:00', 'info', 'f'),
    ])
    expect(facts(incident)).not.toHaveProperty('Acknowledged')
  })

  it('says what is not known for an incident that began before the range', () => {
    const incident = incidentOf([event('r', '14:31:00', 'healthy', 'gone')])
    expect(facts(incident)).toEqual({
      Severity: 'not known',
      Started: 'before the last 1h',
      Recovered: '14:31:00Z',
      Duration: '—',
      Recovery: 'r message',
    })
  })

  it('says the opening is not in the events shown, not that it is older, when they were cut short', () => {
    const [incident] = buildIncidents([event('r', '14:31:00', 'healthy', 'gone')], NOW, true)
    expect(facts(incident as Incident).Started).toBe('not in the events shown')
  })

  it('leads the times with their weekday when the axis runs across midnight', () => {
    const incident = incidentOf([
      event('f', '14:03:10', 'warning'),
      event('r', '14:31:20', 'healthy', 'f'),
    ])
    const dated = Object.fromEntries(
      incidentFacts(incident, 'utc', '24h', true).map(({ label, value }) => [label, value]),
    )
    expect(dated.Started).toBe('Mon 14:03:10Z')
    expect(dated.Recovered).toBe('Mon 14:31:20Z')
  })

  it('writes the times in the chosen timezone', () => {
    const incident = incidentOf([event('f', '14:38:00', 'critical')])
    expect(facts(incident, 'local').Started).toBe(formatTime(ms('14:38:00'), 'local'))
  })
})
