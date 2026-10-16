import type { NetworkSeries, ProbeProtocol, RangeKey } from '@/api/types'
import { RANGE_MS } from '@/lib/range'
import { clamp, hash01, hashString, round1, round2, valueNoise } from './random'
import { DAY, MINUTE } from './time'

/**
 * The synthetic measurement model behind every network number on the Overview.
 *
 * Each target is probed on its own fixed cadence (like the backend's
 * `monitoring_interval_seconds`). A probe is a pure function of (target name,
 * absolute probe time), so any chart built from it is stable across refreshes
 * and scrolls forward as the clock advances; the headline counts and the
 * target's own latest state come from the same function, so they agree.
 */

/** Aggregation bucket per range (the spec: 1 min for 15m and 1h, 5 min for 6h, 15 min for 24h). */
export const BUCKET_MS: Record<RangeKey, number> = {
  '15m': MINUTE,
  '1h': MINUTE,
  '6h': 5 * MINUTE,
  '24h': 15 * MINUTE,
}

/** The trend on the NET TARGETS tile: 12 buckets over the last hour. */
const TREND_BUCKET_MS = 5 * MINUTE
const TREND_POINTS = 12

/** An abnormal stretch of one target, in absolute time. `to: null` = still going on. */
export interface Episode {
  from: number
  to: number | null
  latencyMs?: number
  lossPercent?: number
  failure?: string
}

export interface ProbeModel {
  targetId: string
  /** Seeds every noise stream, so two targets never wobble in step. */
  name: string
  protocol: ProbeProtocol
  intervalMs: number
  /** Offset of the first probe inside an interval: targets are not probed in lockstep. */
  phaseMs: number
  /** Typical latency when healthy, ms. */
  latencyMs: number
  /** Relative spread of an individual probe around the typical latency. */
  jitter: number
  /** Chronic packet loss, percent. */
  lossPercent: number
  /** Chance that a probe fails at random. */
  flakyRate: number
  /** Reports nothing: its probes never reach the console. */
  silent: boolean
  episodes: readonly Episode[]
}

export interface Condition {
  latencyMs: number
  lossPercent: number
  failure: string | null
}

/** Latency and loss ramp into an episode instead of stepping, as a real degradation does. */
const RAMP_MS = 6 * MINUTE
/** An ICMP measurement sends this many pings, so its loss moves in steps of 10%. */
const PINGS = 10
const SPIKE_CHANCE = 0.012

/** Slow, noise-free level of a target at time `t`: its baseline plus a daily curve and a gentle swell. */
function levelFactor(name: string, t: number): number {
  const day = ((t % DAY) / DAY) * Math.PI * 2
  const swell = valueNoise(hashString(name), t / (25 * MINUTE)) - 0.5
  return 1 + 0.04 * Math.sin(day - Math.PI / 2) + 0.1 * swell
}

/** What the link is doing at `t`, before per-probe noise. Used for both probes and the target's live state. */
export function conditionAt(model: ProbeModel, t: number): Condition {
  const factor = levelFactor(model.name, t)
  let latencyMs = model.latencyMs * factor
  let lossPercent = model.lossPercent
  let failure: string | null = null
  for (const episode of model.episodes) {
    if (t < episode.from || (episode.to !== null && t >= episode.to)) continue
    const ramp = clamp((t - episode.from) / RAMP_MS, 0, 1)
    if (episode.latencyMs !== undefined) {
      latencyMs += (episode.latencyMs * factor - latencyMs) * ramp
    }
    if (episode.lossPercent !== undefined) {
      lossPercent += (episode.lossPercent - lossPercent) * ramp
    }
    if (episode.failure !== undefined) failure = episode.failure
  }
  return { latencyMs, lossPercent, failure }
}

export interface Probe {
  at: number
  ok: boolean
  latencyMs: number | null
  /** Packet loss of this measurement; a failed measurement lost everything. */
  lossPercent: number
  failure: string | null
}

export const probeTime = (model: ProbeModel, index: number): number =>
  model.phaseMs + index * model.intervalMs

/** Index of the latest probe that happened at or before `t`. */
export const latestProbeIndex = (model: ProbeModel, t: number): number =>
  Math.floor((t - model.phaseMs) / model.intervalMs)

export function probeAt(model: ProbeModel, index: number): Probe {
  const at = probeTime(model, index)
  const seed = hashString(model.name)
  const condition = conditionAt(model, at)
  const flaked = model.flakyRate > 0 && hash01(seed + 7, index) < model.flakyRate
  if (condition.failure !== null || flaked) {
    return {
      at,
      ok: false,
      latencyMs: null,
      lossPercent: 100,
      failure: condition.failure ?? 'timeout',
    }
  }
  let lossPercent = 0
  if (model.protocol === 'icmp' && condition.lossPercent > 0) {
    let lost = 0
    for (let ping = 0; ping < PINGS; ping += 1) {
      if (hash01(seed + 100 + ping, index) < condition.lossPercent / 100) lost += 1
    }
    lossPercent = (lost / PINGS) * 100
  }
  const spread = 1 + model.jitter * (2 * hash01(seed + 2, index) - 1)
  const spike = hash01(seed + 3, index) < SPIKE_CHANCE ? 1.8 + 1.5 * hash01(seed + 4, index) : 1
  return {
    at,
    ok: true,
    latencyMs: Math.max(0.1, condition.latencyMs * spread * spike),
    lossPercent,
    failure: null,
  }
}

/** Everything the targets measured in `[from, to)`. */
interface BucketTotals {
  probes: number
  failed: number
  /** Mean latency of the successful probes of each target that had one. */
  targetLatencies: number[]
  lossSum: number
  lossCount: number
}

function collect(models: readonly ProbeModel[], from: number, to: number): BucketTotals {
  const totals: BucketTotals = {
    probes: 0,
    failed: 0,
    targetLatencies: [],
    lossSum: 0,
    lossCount: 0,
  }
  for (const model of models) {
    if (model.silent) continue
    let latencySum = 0
    let successes = 0
    const first = Math.ceil((from - model.phaseMs) / model.intervalMs)
    const after = Math.ceil((to - model.phaseMs) / model.intervalMs)
    for (let index = first; index < after; index += 1) {
      const probe = probeAt(model, index)
      totals.probes += 1
      if (!probe.ok || probe.latencyMs === null) {
        totals.failed += 1
        continue
      }
      successes += 1
      latencySum += probe.latencyMs
      // A failed measurement lost every packet by definition. It is counted as a
      // failed probe instead, so a dead link does not drown out the loss trend of
      // the links that still answer.
      if (model.protocol === 'icmp') {
        totals.lossSum += probe.lossPercent
        totals.lossCount += 1
      }
    }
    if (successes > 0) totals.targetLatencies.push(latencySum / successes)
  }
  return totals
}

/** Linear-interpolated percentile of an ascending list. */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const position = fraction * (sorted.length - 1)
  const low = Math.floor(position)
  const high = Math.ceil(position)
  const lowValue = sorted[low] as number
  const highValue = sorted[high] as number
  return lowValue + (highValue - lowValue) * (position - low)
}

/**
 * Latency percentiles and loss per bucket. Only completed buckets are
 * returned: the newest one ends at the latest bucket boundary, so every value
 * is final and a later request shifts the series by whole buckets.
 */
export function buildNetworkSeries(
  models: readonly ProbeModel[],
  range: RangeKey,
  now: number,
): NetworkSeries {
  const bucketMs = BUCKET_MS[range]
  const series: NetworkSeries = {
    generatedAt: new Date(now).toISOString(),
    bucketMs,
    t: [],
    p50: [],
    p95: [],
    lossMean: [],
    failedProbes: [],
    probeCount: [],
    targetCount: models.length,
  }
  if (models.length === 0) return series
  const count = RANGE_MS[range] / bucketMs
  const end = Math.floor(now / bucketMs) * bucketMs
  for (let i = count; i >= 1; i -= 1) {
    const start = end - i * bucketMs
    const totals = collect(models, start, start + bucketMs)
    const latencies = totals.targetLatencies.sort((a, b) => a - b)
    const p50 = percentile(latencies, 0.5)
    const p95 = percentile(latencies, 0.95)
    series.t.push(start)
    series.p50.push(p50 === null ? null : round1(p50))
    series.p95.push(p95 === null ? null : round1(p95))
    series.lossMean.push(totals.lossCount === 0 ? null : round2(totals.lossSum / totals.lossCount))
    series.failedProbes.push(totals.failed)
    series.probeCount.push(totals.probes)
  }
  return series
}

/** Success rate (0-100) per bucket over the last hour, oldest first. Empty when nothing is probed. */
export function successTrend(models: readonly ProbeModel[], now: number): number[] {
  if (models.every((model) => model.silent)) return []
  const end = Math.floor(now / TREND_BUCKET_MS) * TREND_BUCKET_MS
  const trend: number[] = []
  let previous = 100
  for (let i = TREND_POINTS; i >= 1; i -= 1) {
    const start = end - i * TREND_BUCKET_MS
    const { probes, failed } = collect(models, start, start + TREND_BUCKET_MS)
    // A bucket nobody probed in carries the previous rate instead of inventing a dip.
    previous = probes === 0 ? previous : round1(((probes - failed) / probes) * 100)
    trend.push(previous)
  }
  return trend
}
