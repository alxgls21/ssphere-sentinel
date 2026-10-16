import type { HealthStatus } from '@/api/types'
import type { DisplayStatus } from '@/lib/status'

/**
 * A glyph shape: every shown state (the health statuses and offline), plus the
 * provenance-only dotted ring.
 */
export type GlyphShape = DisplayStatus | 'planned'

/**
 * The one place health maps to color. Class names are written out in full so
 * Tailwind's scanner sees them. The token test forbids these utilities
 * anywhere else: render health through StatusGlyph / StatusTag / the meters,
 * so shape and word always accompany color.
 */
export const STATUS_TEXT: Record<GlyphShape, string> = {
  healthy: 'text-healthy',
  warning: 'text-warning',
  critical: 'text-critical',
  offline: 'text-offline',
  unknown: 'text-fg-faint',
  idle: 'text-fg-muted',
  planned: 'text-fg-muted',
}

export const STATUS_TINT: Record<DisplayStatus, string> = {
  healthy: 'bg-healthy-tint',
  warning: 'bg-warning-tint',
  critical: 'bg-critical-tint',
  offline: 'bg-offline-tint',
  unknown: 'bg-transparent',
  idle: 'bg-transparent',
}

export const STATUS_FRAME: Record<DisplayStatus, string> = {
  healthy: 'border-healthy-line',
  warning: 'border-warning-line',
  critical: 'border-critical-line',
  offline: 'border-offline-line',
  unknown: 'border-border-strong',
  idle: 'border-border-strong',
}

/**
 * The 2px (rows) / 4px (verdict) severity edge in the worst child status color.
 * An edge is severity, which decides, so it reads the health status: an offline
 * server keeps the critical edge.
 */
export const STATUS_EDGE: Record<HealthStatus, string> = {
  healthy: 'bg-healthy',
  warning: 'bg-warning',
  critical: 'bg-critical',
  unknown: 'bg-fg-faint',
  idle: 'bg-fg-muted',
}

/** Fixed-width compact words. Domain words (OFFLINE, UNHEALTHY, ...) may replace them. */
export const STATUS_WORD: Record<DisplayStatus, string> = {
  healthy: 'OK',
  warning: 'WARN',
  critical: 'CRIT',
  offline: 'OFFL',
  unknown: 'UNKN',
  idle: 'IDLE',
}

/** Spoken names, for accessible labels. */
export const STATUS_NAME: Record<DisplayStatus, string> = {
  healthy: 'ok',
  warning: 'warning',
  critical: 'critical',
  offline: 'offline',
  unknown: 'unknown',
  idle: 'idle',
}
