/**
 * Number, size and time formatting. All output uses a fixed locale so the
 * console looks identical on every operator's machine (and in tests).
 * Missing values render as an em dash, never as "NaN" or "null".
 */

const LOCALE = 'en-US'
export const EMPTY = '—'

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })

export function formatInteger(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? EMPTY : integer.format(value)
}

export function formatPercent(value: number | null | undefined, fractionDigits = 0): string {
  if (value == null || !Number.isFinite(value)) return EMPTY
  return `${value.toFixed(fractionDigits)}%`
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return EMPTY
  if (ms < 10) return `${ms.toFixed(1)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return EMPTY
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(fractionDigits)} ${BYTE_UNITS[unit]}`
}

const RATE_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'] as const

/** Network rates use decimal (SI) multiples, as interface speeds do. */
export function formatBitsPerSecond(bps: number | null | undefined, fractionDigits = 1): string {
  if (bps == null || !Number.isFinite(bps) || bps < 0) return EMPTY
  let value = bps
  let unit = 0
  while (value >= 1000 && unit < RATE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(fractionDigits)} ${RATE_UNITS[unit]}`
}

/** "14d 3h", "3h 12m", "12m 5s", "42s": the two most significant units. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return EMPTY
  const seconds = Math.floor(totalSeconds)
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${rest}s`
  return `${rest}s`
}

/** Compact age: "now", "42s", "14m", "3h", "2d". Future timestamps read as "now". */
export function formatAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return EMPTY
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return EMPTY
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

const pad = (value: number) => String(value).padStart(2, '0')

export type Timezone = 'utc' | 'local'

/**
 * HH:mm or HH:mm:ss in the chosen timezone. UTC is the console default so
 * shifts and regions agree; callers append "Z" for UTC where space allows.
 */
export function formatTime(ms: number, tz: Timezone, seconds = true): string {
  const date = new Date(ms)
  const [h, m, s] =
    tz === 'utc'
      ? [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
      : [date.getHours(), date.getMinutes(), date.getSeconds()]
  return seconds ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}`
}

export function timezoneLabel(tz: Timezone): string {
  return tz === 'utc' ? 'UTC' : 'local'
}
