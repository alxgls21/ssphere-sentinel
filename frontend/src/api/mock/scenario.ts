/**
 * Mock scenarios let every UI state be reviewed without a backend. Select one
 * with ?mock=<scenario> in the URL or from the command palette (see app/scenario.ts).
 *
 *   normal   the outage story: Piraeus is dark, a disk is filling, a worker
 *            restart-loops, a link drops packets. Verdict CRITICAL.
 *   healthy  the same fleet with nothing wrong: no alerts, verdict NOMINAL.
 *   partial  nothing is failing but a few things are not observed (a server
 *            that never reported, hosts whose containers cannot be read,
 *            targets with no recent probe). Verdict PARTIAL.
 *   stale    each method answers its first call, then fails with 503: the UI
 *            keeps its last good data, which exercises the stale guard.
 *   slow     data arrives after about 3 s.
 *   loading  data never arrives (a request only ends when it is aborted).
 *   empty    nothing is monitored yet: zero counts, empty lists, empty series.
 *   error    every call fails with 503 after a short delay.
 *
 * Everything but slow, loading and error answers after a simulated latency of
 * about 350 ms.
 */
export const MOCK_SCENARIOS = [
  'normal',
  'healthy',
  'partial',
  'stale',
  'slow',
  'loading',
  'empty',
  'error',
] as const
export type MockScenario = (typeof MOCK_SCENARIOS)[number]

/** One line per scenario, for the command palette. */
export const MOCK_SCENARIO_SUMMARY: Record<MockScenario, string> = {
  normal: 'Outage story, verdict CRITICAL',
  healthy: 'Nothing wrong, verdict NOMINAL',
  partial: 'Nothing failing, some things unobserved, verdict PARTIAL',
  stale: 'First answers succeed, then every call fails (stale guard)',
  slow: 'Answers after about 3 s',
  loading: 'Never answers (loading state)',
  empty: 'Nothing monitored yet',
  error: 'Every call fails',
}

function isScenario(value: string | null): value is MockScenario {
  return value !== null && (MOCK_SCENARIOS as readonly string[]).includes(value)
}

/** The scenario named by a `?mock=` value; anything unknown (or absent) is `normal`. */
export function parseMockScenario(value: string | null): MockScenario {
  return isScenario(value) ? value : 'normal'
}
