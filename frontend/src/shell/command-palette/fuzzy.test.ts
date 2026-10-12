import { describe, expect, it } from 'vitest'
import { containsScore, fuzzyScore } from './fuzzy'

const score = (query: string, text: string): number => {
  const result = fuzzyScore(query, text)
  if (result === null) throw new Error(`"${query}" did not match "${text}"`)
  return result
}

describe('fuzzyScore', () => {
  it('matches characters in order and rejects anything else', () => {
    expect(fuzzyScore('egw', 'edge-gw-02')).not.toBeNull()
    expect(fuzzyScore('gwe', 'edge-gw-02')).toBeNull()
    expect(fuzzyScore('zz', 'edge-gw-02')).toBeNull()
  })

  it('is case-insensitive and ignores whitespace in the query', () => {
    expect(score('EDGE', 'edge-gw-02')).toBe(score('edge', 'EDGE-GW-02'))
    expect(score('edge gw', 'edge-gw-02')).toBe(score('edgegw', 'edge-gw-02'))
  })

  it('treats an empty query as matching everything equally', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('   ', 'anything')).toBe(0)
  })

  it('rejects a query longer than the text', () => {
    expect(fuzzyScore('edge-gw-02-extra', 'edge-gw-02')).toBeNull()
  })

  it('prefers a prefix over the same letters in the middle of a word', () => {
    expect(score('ed', 'edge-gw-01')).toBeGreaterThan(score('ed', 'fed-core'))
  })

  it('rewards word starts: an acronym beats a scattered match', () => {
    expect(score('pw', 'payments web')).toBeGreaterThan(score('pw', 'sleepwalker-01'))
  })

  it('rewards consecutive runs over the same letters spread apart', () => {
    expect(score('ab', 'abx')).toBeGreaterThan(score('ab', 'axb'))
  })

  it('finds the best alignment, not the first one', () => {
    // A greedy scan would take the "g" inside "edge" and miss that "gw" is a run at a word start.
    expect(score('gw', 'edge-gw-02')).toBe(score('gw', 'xxx-gw'))
  })

  it('drops matches whose characters are scattered across a long text', () => {
    expect(fuzzyScore('xq', `x${'-'.repeat(30)}q`)).toBeNull()
  })

  it('matches punctuation, so addresses are searchable', () => {
    expect(score('10.20', '10.20.0.1')).toBeGreaterThan(score('10.20', '110.2.0.20'))
    expect(fuzzyScore('0.1', '10.20.0.1')).not.toBeNull()
  })

  it('gives the same score to texts that differ only after the match', () => {
    expect(score('ed', 'edge-gw-01')).toBe(score('ed', 'edge-gw-02'))
  })
})

describe('containsScore', () => {
  it('matches only a contiguous run, ignoring case and spaces', () => {
    expect(containsScore('athens', 'Meridian Logistics / Athens DC')).not.toBeNull()
    expect(containsScore('ATH ens', 'Athens DC')).not.toBeNull()
    expect(containsScore('pir', 'muc-pos-01.internal 10.41.1.10 Munich Stores')).toBeNull()
  })

  it('prefers a match that starts a word, and a longer run', () => {
    const wordStart = containsScore('ath', 'ath-app-01 on Athens DC') ?? 0
    const inside = containsScore('ath', 'bathroom') ?? 0
    expect(wordStart).toBeGreaterThan(inside)
    expect(containsScore('athe', 'Athens') ?? 0).toBeGreaterThan(
      containsScore('ath', 'Athens') ?? 0,
    )
  })

  it('treats an empty query as a match with no score', () => {
    expect(containsScore('  ', 'anything')).toBe(0)
  })
})
