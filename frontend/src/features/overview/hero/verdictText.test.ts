import { describe, expect, it } from 'vitest'
import type { Freshness } from '@/app/live'
import { computeVerdict } from '@/lib/verdict'
import { counts, makeSummary } from './testing'
import { NOT_COUNTED, describeProblems, describeVerdict, formatFigure } from './verdictText'

const verdictOf = (state: Freshness = 'live', summary = makeSummary()) =>
  computeVerdict(summary, state)

describe('describeProblems', () => {
  it('lists problems worst first and leaves out ok and idle', () => {
    expect(
      describeProblems(counts({ healthy: 9, idle: 3, unknown: 1, warning: 2, critical: 4 })),
    ).toBe('4 critical, 2 warning, 1 unknown')
  })

  it('is empty when nothing needs a look', () => {
    expect(describeProblems(counts({ healthy: 9, idle: 3 }))).toBe('')
  })

  it('names offline servers apart from the critical they are part of', () => {
    expect(describeProblems(counts({ healthy: 9, warning: 2, critical: 4, offline: 1 }))).toBe(
      '3 critical, 1 offline, 2 warning',
    )
  })
})

describe('formatFigure', () => {
  it('prints a count, caps it at three digits and uses an em dash without one', () => {
    expect(formatFigure(9)).toBe('9')
    expect(formatFigure(999)).toBe('999')
    expect(formatFigure(1000)).toBe('999+')
    expect(formatFigure(null)).toBe('—')
  })
})

describe('describeVerdict', () => {
  it('states the figure, the denominator and every counted status, without idle', () => {
    const text = describeVerdict(verdictOf(), { hasData: true, freshness: 'live' })
    expect(text.figure).toBe('6')
    expect(text.caption).toBe('need attention of 81')
    expect(text.short).toBe('6 need attention')
    expect(text.summary).toBe('critical, 6 need attention of 81, 3 critical, 3 warning, 75 ok')
  })

  it('reads the same figures with an offline server, and breaks critical down in words only', () => {
    const summary = makeSummary()
    summary.servers.counts = counts({ healthy: 13, warning: 2, critical: 1, offline: 1 })
    const text = describeVerdict(verdictOf('live', summary), { hasData: true, freshness: 'live' })
    expect(text.figure).toBe('6')
    expect(text.caption).toBe('need attention of 81')
    expect(text.short).toBe('6 need attention')
    expect(text.summary).toBe(
      'critical, 6 need attention of 81, 2 critical, 1 offline, 3 warning, 75 ok',
    )
  })

  it('says what the count excludes: idle entities and events, and that incidents are not added', () => {
    const text = describeVerdict(verdictOf(), { hasData: true, freshness: 'live' })
    expect(text.scope).toBe(`3 idle entities are not counted. ${NOT_COUNTED}`)
    expect(NOT_COUNTED).toContain('Events are not counted')
    expect(NOT_COUNTED).toContain(
      'Incidents are not added: they follow the health of what is already counted',
    )
    expect(NOT_COUNTED).toContain('the console API does not serve them')
    // Probe targets and SNMP devices are counted, so the sentence does not list them as left out.
    expect(NOT_COUNTED.split(':')[0]).not.toMatch(/probe targets|SNMP/i)
    // A device is the API's decision, and an interface that is down does not make it unhealthy.
    expect(NOT_COUNTED).toMatch(/interface that is down does not make its device so/)
  })

  it('uses the singular for one idle entity and omits the idle sentence for none', () => {
    const one = makeSummary()
    one.containers.counts.idle = 1
    expect(
      describeVerdict(verdictOf('live', one), { hasData: true, freshness: 'live' }).scope,
    ).toMatch(/^1 idle entity is not counted\./)
    const none = makeSummary()
    none.containers.counts.idle = 0
    expect(
      describeVerdict(verdictOf('live', none), { hasData: true, freshness: 'live' }).scope,
    ).toBe(NOT_COUNTED)
  })

  it('names why there is no verdict, in each case', () => {
    const ctx = (hasData: boolean, freshness: Freshness) => ({ hasData, freshness })
    const none = describeVerdict(computeVerdict(undefined, 'live'), ctx(false, 'live'))
    expect(none).toMatchObject({
      figure: '—',
      caption: 'no data received',
      summary: 'no data, no data received',
    })

    const old = describeVerdict(verdictOf('nodata'), ctx(true, 'nodata'))
    expect(old.caption).toBe('data older than 2 min')

    const empty = makeSummary()
    empty.servers.counts = counts()
    empty.containers.counts = counts()
    expect(describeVerdict(verdictOf('live', empty), ctx(true, 'live')).caption).toBe(
      'nothing monitored yet',
    )
  })

  it('does not report stale idle counts under NO DATA', () => {
    const text = describeVerdict(verdictOf('nodata'), { hasData: true, freshness: 'nodata' })
    expect(text.scope).toBe(NOT_COUNTED)
  })
})
