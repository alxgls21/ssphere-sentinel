/**
 * Small deterministic randomness for mock data. Everything is keyed by a seed
 * and (for time series) by absolute time, so charts are stable across
 * refreshes and re-renders, yet drift naturally as the clock advances.
 */

/** FNV-1a 32-bit hash of a string. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Integer hash -> [0, 1). Stateless: the same (seed, n) always gives the same value. */
export function hash01(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n | 0, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

/** Smooth 1-D value noise in [0, 1): cosine-interpolated hash lattice. `x` is in lattice units. */
export function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const t = (1 - Math.cos(f * Math.PI)) / 2
  return hash01(seed, i) * (1 - t) + hash01(seed, i + 1) * t
}

/** Sequential PRNG (mulberry32), for building fixtures in a fixed order. */
export function createRng(seed: number | string): () => number {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export const round1 = (value: number): number => Math.round(value * 10) / 10
export const round2 = (value: number): number => Math.round(value * 100) / 100
