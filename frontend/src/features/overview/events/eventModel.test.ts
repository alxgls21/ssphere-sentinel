import { describe, expect, it } from 'vitest'
import type { EventLevel, SentinelEvent } from '@/api/types'
import { LEVEL_NAME, LEVEL_STATUS, buildTail, countUnseen } from './eventModel'

const at = (hms: string) => `2026-10-12T${hms}Z`

const event = (
  id: string,
  time: string,
  parentId?: string,
  level: EventLevel = 'warning',
): SentinelEvent => ({
  id,
  at: at(time),
  level,
  subject: { kind: 'server', id, name: id },
  message: id,
  ...(parentId ? { parentId } : {}),
})

const ids = (events: SentinelEvent[]) => buildTail(events).map((line) => line.event.id)

describe('LEVEL_STATUS', () => {
  it('maps event levels onto the status alphabet, info onto the neutral idle bar', () => {
    expect(LEVEL_STATUS).toEqual({
      critical: 'critical',
      warning: 'warning',
      healthy: 'healthy',
      info: 'idle',
    })
  })

  it('speaks info as info, not as idle, and healthy as ok', () => {
    expect(LEVEL_NAME.info).toBe('info')
    expect(LEVEL_NAME.healthy).toBe('ok')
  })
})

describe('buildTail', () => {
  it('lists standalone events newest first', () => {
    const lines = buildTail([
      event('old', '10:00:00'),
      event('new', '12:00:00'),
      event('mid', '11:00:00'),
    ])
    expect(lines.map((l) => l.event.id)).toEqual(['new', 'mid', 'old'])
    expect(lines.every((l) => l.depth === 0 && l.guides.length === 0)).toBe(true)
  })

  it('nests a recovery under its failure, with an elbow guide', () => {
    const lines = buildTail([
      event('recovered', '14:01:55', 'failed', 'healthy'),
      event('failed', '14:01:10'),
    ])
    expect(lines.map((l) => [l.event.id, l.depth, l.guides])).toEqual([
      ['failed', 0, []],
      ['recovered', 1, ['elbow']],
    ])
  })

  it('places a group by its newest line, so a fresh recovery lifts the whole incident', () => {
    const tail = ids([
      event('standalone', '14:03:00'),
      event('failed', '14:00:00'),
      event('recovered', '14:05:00', 'failed', 'healthy'),
      event('older', '13:00:00'),
    ])
    expect(tail).toEqual(['failed', 'recovered', 'standalone', 'older'])
  })

  it('keeps a group below a newer standalone event when its own newest line is older', () => {
    expect(
      ids([
        event('failed', '14:00:00'),
        event('recovered', '14:02:00', 'failed', 'healthy'),
        event('standalone', '14:03:00'),
      ]),
    ).toEqual(['standalone', 'failed', 'recovered'])
  })

  it('reads children in the order they happened, with tee guides until the last', () => {
    const lines = buildTail([
      event('root', '10:00:00'),
      event('second', '10:20:00', 'root'),
      event('first', '10:10:00', 'root'),
    ])
    expect(lines.map((l) => [l.event.id, l.guides])).toEqual([
      ['root', []],
      ['first', ['tee']],
      ['second', ['elbow']],
    ])
  })

  it('keeps the outer vertical line running past a branch that still has siblings coming', () => {
    const lines = buildTail([
      event('root', '10:00:00'),
      event('a', '10:10:00', 'root'),
      event('a1', '10:12:00', 'a'),
      event('b', '10:20:00', 'root'),
    ])
    expect(lines.map((l) => [l.event.id, l.depth, l.guides])).toEqual([
      ['root', 0, []],
      ['a', 1, ['tee']],
      ['a1', 2, ['pipe', 'elbow']],
      ['b', 1, ['elbow']],
    ])
    const closed = buildTail([
      event('root', '10:00:00'),
      event('a', '10:10:00', 'root'),
      event('a1', '10:12:00', 'a'),
    ])
    expect(closed.map((l) => l.guides)).toEqual([[], ['elbow'], ['blank', 'elbow']])
  })

  it('shows an event whose parent is outside the list on its own', () => {
    const lines = buildTail([event('orphan', '12:00:00', 'gone', 'healthy')])
    expect(lines.map((l) => [l.event.id, l.depth])).toEqual([['orphan', 0]])
  })

  it('does not lose or loop on corrupt data where parents form a cycle', () => {
    expect(ids([event('a', '10:00:00', 'b'), event('b', '11:00:00', 'a')]).sort()).toEqual([
      'a',
      'b',
    ])
    expect(ids([event('self', '10:00:00', 'self')])).toEqual(['self'])
  })

  it('is stable for equal times and does not mutate its input', () => {
    const input = [event('b', '10:00:00'), event('a', '10:00:00')]
    const copy = [...input]
    expect(ids(input)).toEqual(['a', 'b'])
    expect(input).toEqual(copy)
  })

  it('returns nothing for no events', () => {
    expect(buildTail([])).toEqual([])
  })
})

describe('countUnseen', () => {
  it('counts the latest events that are not on screen', () => {
    const shown = [event('a', '10:00:00'), event('b', '10:01:00')]
    const latest = [event('c', '10:03:00'), event('d', '10:02:00'), ...shown]
    expect(countUnseen(latest, shown)).toBe(2)
    expect(countUnseen(shown, shown)).toBe(0)
  })

  it('does not count an event that merely left the list', () => {
    const shown = [event('a', '10:00:00'), event('b', '10:01:00')]
    expect(countUnseen([event('b', '10:01:00')], shown)).toBe(0)
  })
})
