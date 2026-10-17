/**
 * Presentational thresholds. These are UI defaults, NOT backend alert rules
 * (the backend has none): wherever one is shown, label it "UI default".
 * Change them here and nowhere else.
 */

/** CPU, memory and disk percent: warning at or above, critical at or above. */
export const RESOURCE_WARN_PERCENT = 80
export const RESOURCE_CRIT_PERCENT = 95

/** A probe is degraded at or above this packet loss (percent)... */
export const LOSS_WARN_PERCENT = 2
/** ...or when its latency is above this (milliseconds). */
export const LATENCY_WARN_MS = 150

/** Data older than this reads STALE; older than NO_DATA reads NO DATA (seconds). */
export const STALE_AFTER_SECONDS = 45
export const NO_DATA_AFTER_SECONDS = 120

/** Default poll interval for live panels (milliseconds). */
export const POLL_MS = 15_000

/**
 * A hidden tab keeps refreshing the shared summary this often, so its title and favicon stay true
 * (well inside NO_DATA_AFTER_SECONDS) without polling every panel nobody can see.
 */
export const HIDDEN_POLL_MS = 60_000

export type ResourceLevel = 'ok' | 'warn' | 'crit'

/*
 * Every check below judges the value AS DISPLAYED (see lib/format): percentages
 * to a whole number, latency to whole milliseconds, loss to one decimal. An
 * operator must never read "95%" beside a warning because the raw value was 94.7,
 * or "150 ms" beside a degraded probe because it was 150.4.
 */

/** The resource limits in force: the console API's, or these defaults. */
export interface ResourceLimits {
  warn: number
  crit: number
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  warn: RESOURCE_WARN_PERCENT,
  crit: RESOURCE_CRIT_PERCENT,
}

export function resourceLevel(
  percent: number,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): ResourceLevel {
  const shown = Math.round(percent)
  if (shown >= limits.crit) return 'crit'
  return shown >= limits.warn ? 'warn' : 'ok'
}

/** Packet loss at or above the warning level, judged to one decimal like it is shown. */
export function lossExceedsWarn(percent: number): boolean {
  return Math.round(percent * 10) / 10 >= LOSS_WARN_PERCENT
}

/** Latency above the warning level, judged to whole milliseconds like it is shown. */
export function latencyExceedsWarn(ms: number): boolean {
  return Math.round(ms) > LATENCY_WARN_MS
}
