export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/**
 * The two readings of the clock every mock builder works from.
 *
 * `now` is the injected clock at the moment of the request: heartbeats, last
 * probes and generatedAt are relative to it. `anchor` is the clock when the
 * mock API was created: the outage story ("Piraeus went dark 14 minutes ago")
 * is pinned to it in absolute time. That keeps every probe measurement a pure
 * function of absolute time (a refresh a minute later returns the same
 * history shifted by exactly one bucket) while the incident still ages
 * realistically in a console left open all night.
 */
export interface Clock {
  now: number
  anchor: number
}

export const toIso = (ms: number): string => new Date(ms).toISOString()
