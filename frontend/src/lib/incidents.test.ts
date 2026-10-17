import { describe, expect, it } from 'vitest'
import type { IncidentEntityKind } from '@/api/types'
import { detail, engine, incident, list, NOW, overview, stepsOf } from '@/features/alerts/testing'
import {
  ENGINE_HEALTH,
  ENGINE_WORD,
  KIND_SHORT,
  allCount,
  conditionBrief,
  conditionText,
  endedCount,
  engineCaveat,
  engineNeedsAttention,
  engineSentence,
  entityTarget,
  incidentOverviewOf,
  incidentPath,
  isOpen,
  openCount,
  openFor,
  reasonText,
  stepText,
  timelineEvents,
} from './incidents'

describe('open and ended', () => {
  it('counts an acknowledged incident as open', () => {
    expect(isOpen('active')).toBe(true)
    expect(isOpen('acknowledged')).toBe(true)
    expect(isOpen('recovered')).toBe(false)
    expect(isOpen('closed')).toBe(false)
  })

  it('sums the API’s counts: open is active and acknowledged, history is recovered and closed', () => {
    const counts = { active: 3, acknowledged: 2, recovered: 5, closed: 7 }
    expect(openCount(counts)).toBe(5)
    expect(endedCount(counts)).toBe(12)
    expect(allCount(counts)).toBe(17)
  })

  it('says how long an open incident has been open, from the API’s time, and nothing for an ended one', () => {
    expect(openFor(incident({ openedSecondsAgo: 3900 }), NOW)).toBe('1h 5m')
    expect(openFor(incident({ status: 'recovered' }), NOW)).toBe('—')
  })
})

describe('where an incident’s object opens', () => {
  it('opens a server, target or device on its own page', () => {
    expect(entityTarget('server', 's1')).toEqual({ pathname: '/servers/s1', extra: {} })
    expect(entityTarget('target', 't1')).toEqual({ pathname: '/network/t1', extra: {} })
    expect(entityTarget('device', 'd1')).toEqual({ pathname: '/snmp/d1', extra: {} })
  })

  it('opens a container on the Docker list focused on it, with its server-qualified reference', () => {
    expect(entityTarget('container', 's1:abc123')).toEqual({
      pathname: '/docker',
      extra: { focus: 's1:abc123' },
    })
  })

  it('opens an interface on its device’s page with that interface chosen', () => {
    expect(entityTarget('interface', 'd1:12')).toEqual({
      pathname: '/snmp/d1',
      extra: { interface: '12' },
    })
  })

  it('keeps a reference one path segment, whatever it holds', () => {
    expect(entityTarget('device', 'a/b c').pathname).toBe('/snmp/a%2Fb%20c')
    expect(incidentPath('a/b c')).toBe('/alerts/a%2Fb%20c')
  })

  it('has a short lead for every kind', () => {
    const kinds: IncidentEntityKind[] = ['server', 'container', 'target', 'device', 'interface']
    expect(kinds.map((kind) => KIND_SHORT[kind])).toEqual(['srv', 'ctr', 'net', 'dev', 'if'])
  })
})

describe('the trigger condition', () => {
  it('words a reason by the kind of object, and shows one it does not know as it came', () => {
    expect(reasonText('server', 'offline')).toBe('offline: no heartbeat')
    expect(reasonText('device', 'unreachable')).toBe('no response to polls')
    expect(reasonText('interface', 'down')).toBe('down, though enabled')
    expect(reasonText('target', 'latency')).toBe('latency over the limit')
    expect(reasonText('container', 'unhealthy')).toBe('unhealthy: failing its health check')
    expect(reasonText('server', 'a_new_reason')).toBe('a new reason')
    expect(reasonText('server', null)).toBeNull()
  })

  it('says what the rule fired on and why, or what it fired on when it was not narrowed', () => {
    expect(conditionText(incident())).toBe('Critical · no response to polls')
    const open = incident({ reason: null, health: 'warning' })
    expect(conditionText(open)).toBe('Warning or critical')
    expect(conditionBrief(open)).toBe('Warning or critical')
    expect(conditionBrief(incident())).toBe('no response to polls')
    expect(conditionText(incident({ health: 'unknown', reason: 'no_poll' }))).toBe(
      'Unknown (no current monitoring data) · never polled',
    )
  })
})

describe('the timeline', () => {
  const recovered = incident({ status: 'recovered' })

  it('words each recorded step, with what was observed where anything was', () => {
    const steps = stepsOf(incident({ status: 'acknowledged' }))
    const item = incident({ status: 'acknowledged' })
    expect(stepText(steps[0]!, item)).toBe('Opened (critical, no response to polls)')
    expect(stepText(steps[1]!, item)).toBe('Acknowledged by maria')
    const all = stepsOf(recovered)
    expect(stepText(all[1]!, recovered)).toBe('Recovery began: the condition cleared (ok)')
    expect(stepText(all[2]!, recovered)).toBe('Recovered: the recovery was confirmed (ok)')
    expect(
      stepText(
        {
          at: all[1]!.at,
          kind: 'recovery_interrupted',
          health: 'critical',
          reason: 'unreachable',
          actor: null,
        },
        recovered,
      ),
    ).toBe('Recovery interrupted: the condition returned (critical, no response to polls)')
  })

  it('words an acknowledgement with no recorded name, and a closure by its reason', () => {
    const item = incident({ status: 'closed', closeReason: 'entity_moved' })
    expect(
      stepText(
        { at: item.openedAt, kind: 'acknowledged', health: null, reason: null, actor: null },
        item,
      ),
    ).toBe('Acknowledged')
    expect(
      stepText(
        { at: item.openedAt, kind: 'closed', health: null, reason: null, actor: null },
        item,
      ),
    ).toBe('Closed: The object moved to another site.')
  })

  it('draws the timeline as log lines: the opening at the incident’s severity, every later step nested under it', () => {
    const events = timelineEvents(detail(recovered))
    expect(events.map((event) => event.level)).toEqual(['critical', 'info', 'healthy'])
    expect(events[0]).not.toHaveProperty('parentId')
    expect(events.slice(1).every((event) => event.parentId === events[0]?.id)).toBe(true)
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
    expect(events.every((event) => event.subject.name === 'ath-core-sw')).toBe(true)
  })

  it('takes each line’s time from the step, and invents none', () => {
    const d = detail(recovered)
    expect(timelineEvents(d).map((event) => event.at)).toEqual(d.timeline.map((step) => step.at))
  })

  it('draws an incident whose steps do not include an opening as unnested lines', () => {
    const d = detail(incident(), {
      timeline: [stepsOf(incident())[0]!].map((s) => ({ ...s, kind: 'closed' as const })),
    })
    expect(timelineEvents(d).every((event) => !('parentId' in event))).toBe(true)
  })

  it('draws a warning severity opening as a warning line, and an interruption as a warning', () => {
    const item = incident({ severity: 'warning', health: 'warning' })
    const d = detail(item, {
      timeline: [
        stepsOf(item)[0]!,
        {
          at: item.openedAt,
          kind: 'recovery_interrupted',
          health: null,
          reason: null,
          actor: null,
        },
      ],
    })
    expect(timelineEvents(d).map((event) => event.level)).toEqual(['warning', 'warning'])
  })
})

describe('the Overview figures', () => {
  it('takes the counts from the API: open is active and acknowledged, critical from its own count', () => {
    const open = list([incident()], {
      counts: { active: 5, acknowledged: 2, recovered: 9, closed: 4 },
      scopeTotal: 20,
    })
    const critical = list([], { counts: { active: 2, acknowledged: 1, recovered: 3, closed: 0 } })
    expect(incidentOverviewOf(open, critical)).toMatchObject({
      open: 7,
      active: 5,
      acknowledged: 2,
      critical: 3,
    })
  })

  it('lists only the rows the first page holds, never a count made from them', () => {
    const rows = [incident({ id: 'a' }), incident({ id: 'b' })]
    const open = list(rows, {
      counts: { active: 40, acknowledged: 0, recovered: 0, closed: 0 },
      scopeTotal: 40,
    })
    const result = incidentOverviewOf(open, list([]))
    expect(result.recent.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(result.open).toBe(40)
  })

  it('has a fixture whose parts agree', () => {
    const value = overview()
    expect(value.open).toBe(value.active + value.acknowledged)
  })
})

describe('the alert engine', () => {
  it('names each of the four states, and never draws one that has not started as ok', () => {
    expect(ENGINE_WORD).toEqual({
      running: 'RUNNING',
      failed: 'FAILED',
      stale: 'STALE',
      never_started: 'NEVER STARTED',
    })
    expect(ENGINE_HEALTH.running).toBe('healthy')
    expect(ENGINE_HEALTH.never_started).toBe('unknown')
    expect(ENGINE_HEALTH.failed).toBe('critical')
    expect(ENGINE_HEALTH.stale).toBe('warning')
  })

  it('needs attention in every state but running', () => {
    expect(engineNeedsAttention(engine('running'))).toBe(false)
    for (const state of ['failed', 'stale', 'never_started'] as const) {
      expect(engineNeedsAttention(engine(state)), state).toBe(true)
    }
  })

  it('says a running engine is evaluating, and when its last cycle succeeded', () => {
    expect(engineSentence(engine('running'), NOW)).toBe(
      'Evaluating every 60 s; its latest cycle succeeded 12s ago.',
    )
  })

  it('says a failed engine failed, with the category of the error and when it last succeeded', () => {
    const sentence = engineSentence(engine('failed'), NOW)
    expect(sentence).toMatch(/failed with a database error 20s ago/)
    expect(sentence).toMatch(/last success was 8m ago/)
    expect(sentence).toMatch(/Incidents shown may be out of date/)
    expect(
      engineSentence(
        engine('failed', {
          lastError: { at: engine('failed').lastError!.at, category: 'internal' },
        }),
        NOW,
      ),
    ).toMatch(/an internal error/)
  })

  it('says a stale engine has stopped or is stuck, for how long, and that nothing opens or recovers', () => {
    const sentence = engineSentence(engine('stale'), NOW)
    expect(sentence).toMatch(/no attempt for 15m/)
    expect(sentence).toMatch(/more than 3m 0s/)
    expect(sentence).toMatch(/stopped or is stuck/)
    expect(sentence).toMatch(/no incident opens or recovers/)
  })

  it('says an engine that never started has evaluated nothing, and that an empty list is not good news', () => {
    const sentence = engineSentence(engine('never_started'), NOW)
    expect(sentence).toMatch(/never run/)
    expect(sentence).toMatch(/does not mean everything is healthy/)
  })

  it('adds a caveat only to a running engine that is not counting silences yet', () => {
    expect(engineCaveat(engine('running'))).toBeNull()
    expect(engineCaveat(engine('running', { monitoringSince: null }))).toMatch(
      /heartbeats are all missing at once/,
    )
    expect(engineCaveat(engine('stale', { monitoringSince: null }))).toBeNull()
  })
})
