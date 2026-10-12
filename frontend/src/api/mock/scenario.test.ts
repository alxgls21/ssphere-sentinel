import { describe, expect, it } from 'vitest'
import { MOCK_SCENARIO_SUMMARY, MOCK_SCENARIOS, parseMockScenario } from './scenario'

describe('mock scenarios', () => {
  it('parses a ?mock= value, and falls back to normal for anything unknown', () => {
    expect(parseMockScenario('stale')).toBe('stale')
    expect(parseMockScenario(null)).toBe('normal')
    expect(parseMockScenario('')).toBe('normal')
    expect(parseMockScenario('nope')).toBe('normal')
    // The value comes from the address bar: never trust it beyond the known names.
    expect(parseMockScenario('__proto__')).toBe('normal')
    expect(parseMockScenario('constructor')).toBe('normal')
  })

  it('describes every scenario for the palette', () => {
    expect(Object.keys(MOCK_SCENARIO_SUMMARY).sort()).toEqual([...MOCK_SCENARIOS].sort())
    for (const line of Object.values(MOCK_SCENARIO_SUMMARY)) expect(line.length).toBeGreaterThan(5)
  })
})
