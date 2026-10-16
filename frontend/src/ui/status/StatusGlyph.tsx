import { cn } from '@/lib/cn'
import { STATUS_TEXT, type GlyphShape } from './style'

/** Pixel sizes of the glyph grid. 6 is the quiet OK dot used inside dense strips. */
export type GlyphSize = 6 | 10 | 12 | 16 | 24

const SIZE_CLASS: Record<GlyphSize, string> = {
  6: 'size-1.5',
  10: 'size-2.5',
  12: 'size-3',
  16: 'size-4',
  24: 'size-6',
}

/** From this size the silhouette carries its interior cue; below it the mark is the plain shape. */
const CUE_FROM: GlyphSize = 10
/** The question mark needs the room of a 16px ring: smaller unknown marks stay a hollow ring. */
const QUESTION_FROM: GlyphSize = 16

/**
 * One path per mark, filled evenodd, so a cue is a hole cut into the solid
 * silhouette (or a solid drawn inside a hole): no mask, no id, no gradient. All
 * sit on the same 10x10 grid with one stroke weight (about 1.3) and corners
 * softened to the same radius.
 */
const CUED = {
  /** Circle, check cut out. */
  healthy:
    'M0.6 5a4.4 4.4 0 1 0 8.8 0a4.4 4.4 0 1 0 -8.8 0ZM2.23 5.6L4.31 7.74L7.82 3.99L6.88 3.11L4.29 5.86L3.17 4.7Z',
  /** Triangle, exclamation mark cut out. */
  warning:
    'M4.62 1.11Q5 0.4 5.38 1.11L9.32 8.49Q9.7 9.2 8.9 9.2L1.1 9.2Q0.3 9.2 0.68 8.49ZM4.2 3.5L5.8 3.5L5.5 6.1L4.5 6.1ZM4.2 7.6a0.8 0.8 0 1 0 1.6 0a0.8 0.8 0 1 0 -1.6 0Z',
  /** Diamond, cross cut out. */
  critical:
    'M4.51 0.59Q5 0.1 5.49 0.59L9.41 4.51Q9.9 5 9.41 5.49L5.49 9.41Q5 9.9 4.51 9.41L0.59 5.49Q0.1 5 0.59 4.51ZM6.31 2.7L7.3 3.69L5.99 5L7.3 6.31L6.31 7.3L5 5.99L3.69 7.3L2.7 6.31L4.01 5L2.7 3.69L3.69 2.7L5 4.01Z',
  /** Rounded square, its diagonal left as a solid band between two holes. */
  offline:
    'M0.9 2.5Q0.9 0.9 2.5 0.9L7.5 0.9Q9.1 0.9 9.1 2.5L9.1 7.5Q9.1 9.1 7.5 9.1L2.5 9.1Q0.9 9.1 0.9 7.5ZM2.15 2.55Q2.15 2.15 2.55 2.15L6.6 2.15Q7 2.15 6.72 2.43L2.43 6.72Q2.15 7 2.15 6.6ZM7.85 7.45Q7.85 7.85 7.45 7.85L3.4 7.85Q3 7.85 3.28 7.57L7.57 3.28Q7.85 3 7.85 3.4Z',
  /** Hollow ring. */
  unknown:
    'M0.6 5a4.4 4.4 0 1 0 8.8 0a4.4 4.4 0 1 0 -8.8 0ZM1.9 5a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0 -6.2 0Z',
} as const

/** The hollow ring with a question mark drawn inside its hole. */
const UNKNOWN_QUESTION =
  'M0.6 5a4.4 4.4 0 1 0 8.8 0a4.4 4.4 0 1 0 -8.8 0ZM1.9 5a3.1 3.1 0 1 0 6.2 0a3.1 3.1 0 1 0 -6.2 0ZM4.29 4.23L4.51 3.68L5 3.5L5.49 3.68L5.58 3.91L4.53 4.83L4.53 5.7L5.47 5.7L5.47 5.27L6.72 4.19L6.21 2.92L5 2.5L3.79 2.92L3.41 3.87ZM4.4 7a0.6 0.6 0 1 0 1.2 0a0.6 0.6 0 1 0 -1.2 0Z'

interface StatusGlyphProps {
  status: GlyphShape
  size?: GlyphSize
  /** Accessible name. Omit when a word sits next to it: the glyph is then decorative. */
  label?: string
  className?: string
}

/**
 * The shape half of the status alphabet, drawn as inline SVG on a 10x10 grid
 * (font subsets carry no geometric shapes) and colored through currentColor,
 * so forced-colors and print keep the shape. Every state keeps a silhouette of
 * its own, because the palette's green, amber and red are only a few delta-E
 * apart under protan and deutan vision:
 *
 *   healthy circle · warning triangle · critical diamond · offline hollow square
 *   unknown ring · idle bar · planned dotted ring
 *
 * From 10px each carries a cue inside (check, exclamation, cross, slash); the 6px
 * mark is the plain shape. Offline is a presentation of critical (see lib/status).
 */
export function StatusGlyph({ status, size = 12, label, className }: StatusGlyphProps) {
  const a11y = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const)
  return (
    <svg
      viewBox="0 0 10 10"
      className={cn(
        'inline-block shrink-0 align-middle',
        SIZE_CLASS[size],
        STATUS_TEXT[status],
        className,
      )}
      data-status={status}
      focusable="false"
      {...a11y}
    >
      {shape(status, size)}
    </svg>
  )
}

function shape(status: GlyphShape, size: GlyphSize) {
  if (status === 'idle') {
    return <rect x="0.8" y="3.4" width="8.4" height="3.2" rx="0.6" fill="currentColor" />
  }
  if (status === 'planned') {
    return (
      <circle
        cx="5"
        cy="5"
        r="3.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="1.5 1.45"
      />
    )
  }
  if (size < CUE_FROM) return plain(status)
  const d = status === 'unknown' && size >= QUESTION_FROM ? UNKNOWN_QUESTION : CUED[status]
  return <path d={d} fill="currentColor" fillRule="evenodd" />
}

/** The 6px marks: the silhouettes alone. The square's edges sit on whole pixels at 6px. */
function plain(status: 'healthy' | 'warning' | 'critical' | 'offline' | 'unknown') {
  switch (status) {
    case 'healthy':
      return <circle cx="5" cy="5" r="4" fill="currentColor" />
    case 'warning':
      return <path d="M5 1 L9.2 8.6 H0.8 Z" fill="currentColor" />
    case 'critical':
      return <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="currentColor" />
    case 'offline':
      return <rect x="1.67" y="1.67" width="6.66" height="6.66" rx="1" fill="currentColor" />
    case 'unknown':
      return <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  }
}
