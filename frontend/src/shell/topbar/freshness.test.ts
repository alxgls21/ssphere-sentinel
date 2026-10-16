import { describe, expect, it } from 'vitest'
import { compactAge, describeFreshness } from './freshness'

describe('compactAge', () => {
  it.each([
    [0, '0s'],
    [59, '59s'],
    [60, '1m'],
    [119, '1m'],
    [120, '2m'],
    [3599, '59m'],
    [3600, '1h'],
    [86_399, '23h'],
    [86_400, '1d'],
  ])('%i seconds reads %s', (seconds, text) => {
    expect(compactAge(seconds)).toBe(text)
  })
})

describe('describeFreshness', () => {
  it('words each state the way the spec does', () => {
    expect(describeFreshness('live', 3).text).toBe('updated 3s ago')
    expect(describeFreshness('fetching', 3).text).toBe('updating')
    expect(describeFreshness('paused', 41).text).toBe('PAUSED 41s')
    expect(describeFreshness('stale', 52).text).toBe('STALE 52s')
    expect(describeFreshness('nodata', 120).text).toBe('NO DATA 2m')
  })

  it('has no age to show before the first load, or when every request failed', () => {
    expect(describeFreshness('live', null).text).toBe('updating')
    expect(describeFreshness('nodata', null).text).toBe('NO DATA')
    expect(describeFreshness('paused', null).text).toBe('PAUSED')
  })

  it('speaks a state only when it matters: updating is part of being live', () => {
    expect(describeFreshness('live', 3).spoken).toBe('Updates are arriving')
    expect(describeFreshness('fetching', 3).spoken).toBe('Updates are arriving')
    expect(describeFreshness('paused', 41).spoken).toBe('Updates are paused')
    expect(describeFreshness('stale', 52).spoken).toBe('Data is stale')
    expect(describeFreshness('nodata', 120).spoken).toBe('No data')
  })

  it('never says the data is live: the chip reports that updates arrive, not where the data comes from', () => {
    for (const state of ['live', 'fetching', 'paused', 'stale', 'nodata'] as const) {
      expect(describeFreshness(state, 52).spoken).not.toMatch(/\blive\b/i)
    }
  })

  it('never puts the ticking age in what is spoken', () => {
    for (const state of ['live', 'fetching', 'paused', 'stale', 'nodata'] as const) {
      expect(describeFreshness(state, 52).spoken).not.toMatch(/\d/)
    }
  })
})
