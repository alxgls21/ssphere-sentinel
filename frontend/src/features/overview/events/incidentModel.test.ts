import { describe, expect, it } from 'vitest'
import type { EventLevel, SentinelEvent } from '@/api/types'
import { RANGE_MS } from '@/lib/range'
import { axisOf, buildIncidents, countIncidents, spanOf, type Incident } from './incidentModel'

const MINUTE = 60_000
const at = (hms: string) => `2026-10-12T${hms}Z`
const ms = (hms: string) => Date.parse(at(hms))
const NOW = ms('15:00:00')

const event = (
  id: string,
  time: string,
  level: EventLevel,
  parentId?: string,
  subject = 'srv',
): SentinelEvent => ({
  id,
  at: at(time),
  level,
  subject: { kind: 'server', id: subject, name: subject },
  message: `${id} message`,
  ...(parentId ? { parentId } : {}),
})

const only = (events: SentinelEvent[], now = NOW): Incident => {
  const incidents = buildIncidents(events, now)
  expect(incidents).toHaveLength(1)
  return incidents[0] as Incident
}

describe('buildIncidents', () => {
  describe('opening', () => {
    it('opens an incident at a critical event with no parent', () => {
      expect(only([event('f', '14:00:00', 'critical')])).toEqual({
        id: 'f',
        subject: { kind: 'server', id: 'srv', name: 'srv' },
        severity: 'critical',
        start: ms('14:00:00'),
        message: 'f message',
        recovery: null,
        status: 'ongoing',
        durationMs: 60 * MINUTE,
        missingOpening: null,
      })
    })

    it('opens one at a warning too, and keeps the level it opened at', () => {
      expect(only([event('f', '14:00:00', 'warning')]).severity).toBe('warning')
    })

    it('does not open one at an info event, or at a healthy event that stands alone', () => {
      expect(
        buildIncidents([event('i', '14:00:00', 'info'), event('h', '14:10:00', 'healthy')], NOW),
      ).toEqual([])
    })

    it('does not make a second incident of a failure that follows from another', () => {
      const incident = only([
        event('first', '14:00:00', 'warning'),
        event('worse', '14:10:00', 'critical', 'first'),
        event('ok', '14:20:00', 'healthy', 'worse'),
      ])
      expect(incident.id).toBe('first')
      expect(incident.severity).toBe('warning')
      expect(incident.status).toBe('resolved')
      expect(incident.recovery?.at).toBe(ms('14:20:00'))
    })

    it('lets an opening whose own parent is outside the list stand on its own, as the log does', () => {
      const incident = only([event('f', '14:00:00', 'critical', 'gone')])
      expect(incident.missingOpening).toBeNull()
      expect(incident.start).toBe(ms('14:00:00'))
    })

    it('returns nothing for no events', () => {
      expect(buildIncidents([], NOW)).toEqual([])
    })
  })

  describe('recovery', () => {
    it('is closed by a healthy event nested under it, and says when and with what message', () => {
      const incident = only([
        event('f', '14:00:00', 'critical'),
        event('r', '14:28:00', 'healthy', 'f'),
      ])
      expect(incident.status).toBe('resolved')
      expect(incident.recovery).toEqual({ at: ms('14:28:00'), message: 'r message' })
      expect(incident.durationMs).toBe(28 * MINUTE)
    })

    it('is not closed by an info event', () => {
      const incident = only([
        event('f', '14:00:00', 'critical'),
        event('ack', '14:05:00', 'info', 'f'),
      ])
      expect(incident.status).toBe('ongoing')
      expect(incident.recovery).toBeNull()
    })

    it('is closed by its recovery whatever info events are nested under it', () => {
      const incident = only([
        event('f', '14:00:00', 'warning'),
        event('ack', '14:05:00', 'info', 'f'),
        event('r', '14:30:00', 'healthy', 'f'),
      ])
      expect(incident.status).toBe('resolved')
    })

    it('is found under an info event, at any depth', () => {
      const incident = only([
        event('f', '14:00:00', 'warning'),
        event('ack', '14:05:00', 'info', 'f'),
        event('r', '14:30:00', 'healthy', 'ack'),
      ])
      expect(incident.status).toBe('resolved')
      expect(incident.recovery?.at).toBe(ms('14:30:00'))
    })

    it('is the first of several healthy events nested under it', () => {
      const incident = only([
        event('f', '14:00:00', 'critical'),
        event('late', '14:50:00', 'healthy', 'f'),
        event('early', '14:20:00', 'healthy', 'f'),
      ])
      expect(incident.recovery).toEqual({ at: ms('14:20:00'), message: 'early message' })
    })

    it('is not taken from a healthy event nested under some other incident', () => {
      const incidents = buildIncidents(
        [
          event('a', '14:00:00', 'critical', undefined, 'a'),
          event('b', '14:10:00', 'warning', undefined, 'b'),
          event('b-ok', '14:20:00', 'healthy', 'b', 'b'),
        ],
        NOW,
      )
      expect(incidents.map((i) => [i.id, i.status])).toEqual([
        ['a', 'ongoing'],
        ['b', 'resolved'],
      ])
    })

    it('does not open one at an info event that stands on its own', () => {
      const incidents = buildIncidents(
        [event('f', '14:00:00', 'critical'), event('note', '14:05:00', 'info')],
        NOW,
      )
      expect(incidents).toHaveLength(1)
    })
  })

  describe('an incident that began before the range', () => {
    it('comes from a recovery whose failure is not in the list, with what is not known left empty', () => {
      const incident = only([event('r', '14:10:00', 'healthy', 'before-range')])
      expect(incident).toEqual({
        id: 'r',
        subject: { kind: 'server', id: 'srv', name: 'srv' },
        severity: null,
        start: null,
        message: null,
        recovery: { at: ms('14:10:00'), message: 'r message' },
        status: 'resolved',
        durationMs: null,
        missingOpening: 'before-range',
      })
    })

    it('is not claimed to predate the range when the list is only the newest events of it', () => {
      const incidents = buildIncidents([event('r', '14:10:00', 'healthy', 'cut-off')], NOW, true)
      expect(incidents).toHaveLength(1)
      expect(incidents[0]).toMatchObject({
        id: 'r',
        severity: null,
        start: null,
        missingOpening: 'not-shown',
      })
    })

    it('still opens an incident at a failure that is in a truncated list', () => {
      const incident = only([event('f', '14:00:00', 'critical')])
      expect(buildIncidents([event('f', '14:00:00', 'critical')], NOW, true)).toEqual([incident])
    })

    it('stays an incident with no opening when an info event names the same missing failure', () => {
      const incident = only([
        event('r', '14:10:00', 'healthy', 'before-range'),
        event('ack', '13:50:00', 'info', 'before-range'),
      ])
      expect(incident.missingOpening).toBe('before-range')
      expect(incident.status).toBe('resolved')
    })

    it('is one incident when two recoveries name the same missing failure, closed by the first', () => {
      const incident = only([
        event('second', '14:30:00', 'healthy', 'before-range'),
        event('first', '14:10:00', 'healthy', 'before-range'),
      ])
      expect(incident.id).toBe('first')
      expect(incident.recovery?.at).toBe(ms('14:10:00'))
    })

    it('is one incident per missing failure', () => {
      expect(
        buildIncidents(
          [
            event('r1', '14:10:00', 'healthy', 'gone-a'),
            event('r2', '14:20:00', 'healthy', 'gone-b'),
          ],
          NOW,
        ),
      ).toHaveLength(2)
    })

    it('does not come from an acknowledgement alone', () => {
      expect(buildIncidents([event('ack', '14:05:00', 'info', 'before-range')], NOW)).toEqual([])
    })

    it('does not double count the recovery of an opening that is itself in the list', () => {
      const incidents = buildIncidents(
        [
          event('f', '14:00:00', 'critical', 'before-range'),
          event('r', '14:20:00', 'healthy', 'f'),
        ],
        NOW,
      )
      expect(incidents.map((i) => [i.id, i.missingOpening])).toEqual([['f', null]])
    })
  })

  describe('corrupt parents', () => {
    it('does not hang or lose the opening when parents form a cycle', () => {
      const incidents = buildIncidents(
        [event('a', '14:00:00', 'critical', 'b'), event('b', '14:10:00', 'warning', 'a')],
        NOW,
      )
      expect(incidents.map((i) => i.id).sort()).toEqual(['a', 'b'])
      expect(incidents.every((i) => i.status === 'ongoing')).toBe(true)
    })

    it('does not hang on an event that is its own parent', () => {
      expect(only([event('self', '14:00:00', 'critical', 'self')]).id).toBe('self')
    })

    it('does not make an incident of a recovery whose parent is only part of a cycle', () => {
      expect(
        buildIncidents(
          [event('a', '14:00:00', 'healthy', 'b'), event('b', '14:10:00', 'healthy', 'a')],
          NOW,
        ),
      ).toEqual([])
    })
  })

  describe('duration', () => {
    it('runs from the start to now while ongoing, so it follows the injected now', () => {
      const events = [event('f', '14:00:00', 'critical')]
      expect(only(events, ms('14:00:00') + 22 * MINUTE).durationMs).toBe(22 * MINUTE)
      expect(only(events, ms('14:00:00') + 23 * MINUTE).durationMs).toBe(23 * MINUTE)
    })

    it('runs from the start to the recovery once resolved, whatever now is', () => {
      const events = [event('f', '14:00:00', 'critical'), event('r', '14:28:00', 'healthy', 'f')]
      expect(only(events, ms('14:30:00')).durationMs).toBe(28 * MINUTE)
      expect(only(events, ms('23:00:00')).durationMs).toBe(28 * MINUTE)
    })

    it('is zero at its boundaries: now is the start, the recovery is the start', () => {
      expect(only([event('f', '14:00:00', 'critical')], ms('14:00:00')).durationMs).toBe(0)
      expect(
        only([event('f', '14:00:00', 'critical'), event('r', '14:00:00', 'healthy', 'f')])
          .durationMs,
      ).toBe(0)
    })

    it('is never negative, however the clocks disagree', () => {
      expect(only([event('f', '14:00:00', 'critical')], ms('13:59:00')).durationMs).toBe(0)
      // A recovery stamped before its failure is not a recovery: the incident is still ongoing.
      const early = only([
        event('f', '14:00:00', 'critical'),
        event('r', '13:50:00', 'healthy', 'f'),
      ])
      expect(early.status).toBe('ongoing')
      expect(early.recovery).toBeNull()
    })

    it('keeps sub-minute precision for the text to round', () => {
      expect(only([event('f', '14:00:00', 'critical')], ms('14:00:59')).durationMs).toBe(59_000)
    })

    it('reads no clock of its own: the same input gives the same answer', () => {
      const events = [event('f', '14:00:00', 'critical')]
      expect(buildIncidents(events, NOW)).toEqual(buildIncidents(events, NOW))
    })
  })

  describe('order', () => {
    const ids = (events: SentinelEvent[]) => buildIncidents(events, NOW).map((i) => i.id)

    it('lists ongoing before resolved, whatever the starts', () => {
      expect(
        ids([
          event('resolved-late', '14:30:00', 'critical'),
          event('resolved-late-ok', '14:40:00', 'healthy', 'resolved-late'),
          event('ongoing-early', '10:00:00', 'warning'),
        ]),
      ).toEqual(['ongoing-early', 'resolved-late'])
    })

    it('puts critical before warning among the ongoing, then the newest start first', () => {
      expect(
        ids([
          event('warn-late', '14:50:00', 'warning'),
          event('crit-early', '09:00:00', 'critical'),
          event('crit-late', '14:00:00', 'critical'),
          event('warn-early', '10:00:00', 'warning'),
        ]),
      ).toEqual(['crit-late', 'crit-early', 'warn-late', 'warn-early'])
    })

    it('lists the resolved newest start first, whatever their severity', () => {
      expect(
        ids([
          event('a', '10:00:00', 'critical'),
          event('a-ok', '10:10:00', 'healthy', 'a'),
          event('b', '12:00:00', 'warning'),
          event('b-ok', '12:10:00', 'healthy', 'b'),
          event('c', '11:00:00', 'critical'),
          event('c-ok', '11:10:00', 'healthy', 'c'),
        ]),
      ).toEqual(['b', 'c', 'a'])
    })

    it('puts an incident that began before the range last among the resolved, the latest recovery first', () => {
      expect(
        ids([
          event('early-ok', '14:30:00', 'healthy', 'gone-1'),
          event('later-ok', '14:50:00', 'healthy', 'gone-2'),
          event('f', '10:00:00', 'warning'),
          event('f-ok', '10:10:00', 'healthy', 'f'),
        ]),
      ).toEqual(['f', 'later-ok', 'early-ok'])
    })

    it('breaks a tie by id, so equal starts never swap places between refreshes', () => {
      const events = [event('b', '14:00:00', 'critical'), event('a', '14:00:00', 'critical')]
      expect(ids(events)).toEqual(['a', 'b'])
      expect(ids([...events].reverse())).toEqual(['a', 'b'])
    })

    it('does not mutate its input', () => {
      const input = [event('b', '14:00:00', 'critical'), event('a', '15:00:00', 'warning')]
      const copy = [...input]
      buildIncidents(input, NOW)
      expect(input).toEqual(copy)
    })
  })
})

describe('buildIncidents: one record per event id', () => {
  const failure = () => event('f', '14:00:00', 'critical')
  const recovery = () => event('r', '14:28:00', 'healthy', 'f')

  it('opens one incident when the opening event is repeated', () => {
    const incidents = buildIncidents([failure(), failure(), failure()], NOW)
    expect(incidents).toHaveLength(1)
    expect(countIncidents(incidents)).toEqual({ ongoing: 1, resolved: 0 })
  })

  it('resolves once when the recovery is repeated', () => {
    const incident = only([failure(), recovery(), recovery(), recovery()])
    expect(incident.status).toBe('resolved')
    expect(incident.recovery).toEqual({ at: ms('14:28:00'), message: 'r message' })
    expect(incident.durationMs).toBe(28 * MINUTE)
  })

  it('gives the same incidents however the repeats are ordered', () => {
    const forward = buildIncidents([failure(), recovery(), failure(), recovery()], NOW)
    const backward = buildIncidents([recovery(), recovery(), failure(), failure()], NOW)
    expect(backward).toEqual(forward)
    expect(forward).toHaveLength(1)
  })

  it('keeps the earlier record when one id arrives twice with different content', () => {
    const first = { ...failure(), level: 'warning' as const, message: 'first' }
    const later = { ...failure(), at: at('14:10:00'), message: 'later' }
    for (const events of [
      [first, later],
      [later, first],
    ]) {
      const incident = only(events)
      expect(incident.severity).toBe('warning')
      expect(incident.message).toBe('first')
      expect(incident.start).toBe(ms('14:00:00'))
    }
  })

  it('counts events that only look alike as the distinct events they are', () => {
    const twin = (id: string, subject: string) => ({
      ...event(id, '14:00:00', 'critical', undefined, subject),
      message: 'same message',
    })
    const incidents = buildIncidents([twin('a', 'one'), twin('b', 'two')], NOW)
    expect(incidents.map((incident) => incident.id).toSorted()).toEqual(['a', 'b'])
  })

  it('never gives two incidents the same id', () => {
    const incidents = buildIncidents(
      [
        failure(),
        failure(),
        event('x', '13:00:00', 'healthy', 'gone', 'other'),
        event('x', '13:00:00', 'healthy', 'gone', 'other'),
      ],
      NOW,
    )
    const keys = incidents.map((incident) => incident.id)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.toSorted()).toEqual(['f', 'x'])
  })
})

describe('buildIncidents: who a recovery belongs to', () => {
  it('resolves A when A recovers', () => {
    const incident = only([
      event('a', '14:00:00', 'critical', undefined, 'A'),
      event('a-ok', '14:20:00', 'healthy', 'a', 'A'),
    ])
    expect(incident.status).toBe('resolved')
    expect(incident.subject.id).toBe('A')
  })

  it('leaves A ongoing when B, whose failure followed from A, fails and recovers', () => {
    const incident = only([
      event('a', '14:00:00', 'critical', undefined, 'A'),
      event('b', '14:05:00', 'critical', 'a', 'B'),
      event('b-ok', '14:20:00', 'healthy', 'b', 'B'),
    ])
    expect(incident.subject.id).toBe('A')
    expect(incident.status).toBe('ongoing')
    expect(incident.recovery).toBeNull()
  })

  it('leaves A ongoing when only B recovers', () => {
    const incident = only([
      event('a', '14:00:00', 'critical', undefined, 'A'),
      event('b-ok', '14:20:00', 'healthy', 'a', 'B'),
    ])
    expect(incident.status).toBe('ongoing')
    expect(incident.recovery).toBeNull()
  })

  it('resolves A by its own recovery even when B recovered first', () => {
    const incident = only([
      event('a', '14:00:00', 'critical', undefined, 'A'),
      event('b-ok', '14:10:00', 'healthy', 'a', 'B'),
      event('a-ok', '14:20:00', 'healthy', 'a', 'A'),
    ])
    expect(incident.status).toBe('resolved')
    expect(incident.recovery?.at).toBe(ms('14:20:00'))
  })

  it('tells subjects of different kinds apart even when their ids match', () => {
    const container = { kind: 'container' as const, id: 'A', name: 'A' }
    const incident = only([
      event('a', '14:00:00', 'critical', undefined, 'A'),
      { ...event('c-ok', '14:20:00', 'healthy', 'a'), subject: container },
    ])
    expect(incident.status).toBe('ongoing')
  })

  it('invents no recovery when a subject is not named', () => {
    const unnamed = { kind: 'server' as const, id: '', name: '' }
    expect(
      only([
        event('a', '14:00:00', 'critical', undefined, 'A'),
        { ...event('x', '14:20:00', 'healthy', 'a'), subject: unnamed },
      ]).status,
    ).toBe('ongoing')
    expect(
      only([
        { ...event('a', '14:00:00', 'critical'), subject: unnamed },
        { ...event('x', '14:20:00', 'healthy', 'a'), subject: unnamed },
      ]).status,
    ).toBe('ongoing')
  })

  it('does not read a recovery stamped before the failure as its recovery', () => {
    const incident = only([
      event('a', '14:00:00', 'critical', undefined, 'A'),
      event('a-ok', '13:50:00', 'healthy', 'a', 'A'),
    ])
    expect(incident.status).toBe('ongoing')
  })

  it('takes the first of several recoveries by time, whatever the order of the list', () => {
    const events = [
      event('a', '14:00:00', 'critical', undefined, 'A'),
      event('late', '14:40:00', 'healthy', 'a', 'A'),
      event('early', '14:20:00', 'healthy', 'a', 'A'),
    ]
    expect(only(events).recovery?.at).toBe(ms('14:20:00'))
    expect(only(events.toReversed()).recovery?.at).toBe(ms('14:20:00'))
  })

  it('does not take the recovery of another subject for the missing failure of a stray recovery', () => {
    const incidents = buildIncidents(
      [
        event('a-ok', '14:10:00', 'healthy', 'gone', 'A'),
        event('b-ok', '14:20:00', 'healthy', 'gone', 'B'),
      ],
      NOW,
    )
    expect(incidents.map((incident) => incident.subject.id).toSorted()).toEqual(['A', 'B'])
    expect(incidents.every((incident) => incident.missingOpening === 'before-range')).toBe(true)
  })
})

describe('buildIncidents: no acknowledgement is claimed', () => {
  const claims = (incident: Incident) => Object.keys(incident).filter((key) => /ack/i.test(key))
  const failure = () => event('a', '14:00:00', 'critical', undefined, 'A')

  it('claims none for an info event of another subject nested under the failure', () => {
    const incident = only([
      failure(),
      {
        ...event('b-info', '14:05:00', 'info', 'a', 'B'),
        message: 'B diagnostics collected; no acknowledgement.',
      },
    ])
    expect(claims(incident)).toEqual([])
    expect(incident.status).toBe('ongoing')
  })

  it('claims none for an info event of the same subject that is not an acknowledgement', () => {
    const incident = only([failure(), event('a-info', '14:05:00', 'info', 'a', 'A')])
    expect(claims(incident)).toEqual([])
  })

  it('claims none for an info event whose text says "acknowledged"', () => {
    const incident = only([
      failure(),
      { ...event('a-info', '14:05:00', 'info', 'a', 'A'), message: 'alert acknowledged by ops' },
    ])
    expect(claims(incident)).toEqual([])
  })

  it('claims none for an incident without an opening', () => {
    const incident = only([
      event('a-ok', '14:20:00', 'healthy', 'gone', 'A'),
      { ...event('a-info', '14:10:00', 'info', 'gone', 'A'), message: 'acknowledged' },
    ])
    expect(claims(incident)).toEqual([])
  })

  it('claims none however duplicate and out-of-order events are arranged', () => {
    const info = { ...event('a-info', '14:05:00', 'info', 'a', 'A'), message: 'acknowledged' }
    const events = [info, failure(), { ...info }, failure(), { ...info }]
    for (const arranged of [events, events.toReversed()]) {
      expect(buildIncidents(arranged, NOW).flatMap(claims)).toEqual([])
    }
  })

  it('leaves recovery, status and duration the same with or without info events', () => {
    const plain = [failure(), event('a-ok', '14:28:00', 'healthy', 'a', 'A')]
    const noted = [...plain, event('a-info', '14:05:00', 'info', 'a', 'A')]
    expect(buildIncidents(noted, NOW)).toEqual(buildIncidents(plain, NOW))
  })
})

describe('countIncidents', () => {
  it('counts the ongoing and the resolved', () => {
    const incidents = buildIncidents(
      [
        event('a', '14:00:00', 'critical'),
        event('b', '14:10:00', 'warning'),
        event('c', '13:00:00', 'warning'),
        event('c-ok', '13:10:00', 'healthy', 'c'),
      ],
      NOW,
    )
    expect(countIncidents(incidents)).toEqual({ ongoing: 2, resolved: 1 })
    expect(countIncidents([])).toEqual({ ongoing: 0, resolved: 0 })
  })
})

describe('axis and span', () => {
  const axis = axisOf(NOW, '1h')
  const spanOfEvents = (events: SentinelEvent[]) => spanOf(only(events), axis)

  it('covers the range, ending at now', () => {
    expect(axis).toEqual({ start: NOW - 60 * MINUTE, end: NOW })
    expect(RANGE_MS).toEqual({
      '15m': 15 * MINUTE,
      '1h': 60 * MINUTE,
      '6h': 360 * MINUTE,
      '24h': 1440 * MINUTE,
    })
  })

  it('places a resolved incident between its start and its recovery', () => {
    expect(
      spanOfEvents([event('f', '14:15:00', 'critical'), event('r', '14:45:00', 'healthy', 'f')]),
    ).toEqual({ from: 0.25, to: 0.75, clipped: false })
  })

  it('runs an ongoing incident to the right edge', () => {
    expect(spanOfEvents([event('f', '14:30:00', 'critical')])).toEqual({
      from: 0.5,
      to: 1,
      clipped: false,
    })
  })

  it('starts at the left edge without clipping when the start is exactly the start of the axis', () => {
    expect(spanOfEvents([event('f', '14:00:00', 'critical')])).toMatchObject({
      from: 0,
      clipped: false,
    })
  })

  it('clips a start that is before the axis, at the left edge', () => {
    expect(spanOfEvents([event('f', '13:59:59', 'critical')])).toMatchObject({
      from: 0,
      clipped: true,
    })
  })

  it('starts an incident that began before the range at the left edge, clipped, and ends it at its recovery', () => {
    expect(spanOfEvents([event('r', '14:30:00', 'healthy', 'gone')])).toEqual({
      from: 0,
      to: 0.5,
      clipped: true,
    })
  })

  it('keeps everything on the axis: a recovery after now or before the axis does not leave it', () => {
    expect(
      spanOfEvents([event('f', '14:30:00', 'critical'), event('r', '15:30:00', 'healthy', 'f')]),
    ).toMatchObject({ from: 0.5, to: 1 })
    expect(
      spanOfEvents([event('f', '13:00:00', 'critical'), event('r', '13:30:00', 'healthy', 'f')]),
    ).toEqual({ from: 0, to: 0, clipped: true })
  })

  it('never ends before it starts', () => {
    const backwards: Incident = {
      ...only([event('f', '14:30:00', 'critical')]),
      status: 'resolved',
      recovery: { at: ms('14:20:00'), message: 'r message' },
    }
    expect(spanOf(backwards, axisOf(NOW, '1h'))).toEqual({ from: 0.5, to: 0.5, clipped: false })
  })

  it('follows the range: the same start sits further left on a longer axis', () => {
    const incident = only([event('f', '14:30:00', 'critical')])
    expect(spanOf(incident, axisOf(NOW, '1h')).from).toBe(0.5)
    expect(spanOf(incident, axisOf(NOW, '6h')).from).toBeCloseTo(11 / 12)
  })
})
