import { describe, expect, it } from 'vitest'
import type { Freshness } from '@/app/live'
import { computeVerdict } from '@/lib/verdict'
import { documentTitle, verdictSentence } from './documentStatus'
import { makeSummary } from './testing'

const verdict = (summary: Parameters<typeof makeSummary>[0], freshness: Freshness = 'live') =>
  computeVerdict(makeSummary(summary), freshness)

describe('documentTitle', () => {
  it('leads with the verdict, so a background tab can be read: "[MOCK] ◆ 4 CRIT - Overview - Sentinel"', () => {
    const critical = verdict({
      servers: { critical: 1 },
      containers: { critical: 2 },
      targets: { critical: 1 },
    })
    expect(documentTitle({ mock: true, verdict: critical, screen: 'Overview' })).toBe(
      '[MOCK] ◆ 4 CRIT - Overview - Sentinel',
    )
  })

  it('counts the verdict’s own status: warnings when degraded, unknowns when partial', () => {
    const degraded = verdict({ servers: { warning: 2 }, targets: { warning: 3 } })
    expect(documentTitle({ mock: true, verdict: degraded, screen: 'Servers' })).toBe(
      '[MOCK] ▲ 5 WARN - Servers - Sentinel',
    )
    const partial = verdict({ servers: { unknown: 2 } })
    expect(documentTitle({ mock: true, verdict: partial, screen: 'Docker' })).toBe(
      '[MOCK] ○ 2 UNKN - Docker - Sentinel',
    )
  })

  it('counts what is fine when nominal', () => {
    const nominal = verdict({})
    expect(documentTitle({ mock: true, verdict: nominal, screen: 'Overview' })).toBe(
      '[MOCK] ● 38 OK - Overview - Sentinel',
    )
  })

  it('says NO DATA, without a count, when the data is dead', () => {
    const dead = verdict({ servers: { critical: 3 } }, 'nodata')
    expect(documentTitle({ mock: true, verdict: dead, screen: 'Overview' })).toBe(
      '[MOCK] ○ NO DATA - Overview - Sentinel',
    )
  })

  it('drops the MOCK prefix for a real API', () => {
    const critical = verdict({ servers: { critical: 1 } })
    expect(documentTitle({ mock: false, verdict: critical, screen: 'Overview' })).toBe(
      '◆ 1 CRIT - Overview - Sentinel',
    )
  })

  it('claims no verdict before the first answer', () => {
    expect(documentTitle({ mock: true, verdict: null, screen: 'Overview' })).toBe(
      '[MOCK] Overview - Sentinel',
    )
    expect(documentTitle({ mock: false, verdict: null, screen: 'Not found' })).toBe(
      'Not found - Sentinel',
    )
  })
})

describe('verdictSentence', () => {
  it('says the verdict and how many need attention', () => {
    const critical = verdict({ servers: { critical: 1, warning: 2 }, targets: { unknown: 1 } })
    expect(verdictSentence(critical)).toBe('Verdict CRITICAL. 4 of 42 need attention.')
  })

  it('says only the verdict when there is no data', () => {
    expect(verdictSentence(verdict({}, 'nodata'))).toBe('Verdict NO DATA.')
  })
})
