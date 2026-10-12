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
 * so forced-colors and print keep the shape.
 *
 *   healthy circle · warning triangle · critical diamond · idle bar · unknown ring · planned dotted ring
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
      {shape(status)}
    </svg>
  )
}

function shape(status: GlyphShape) {
  switch (status) {
    case 'healthy':
      return <circle cx="5" cy="5" r="4" fill="currentColor" />
    case 'warning':
      return <path d="M5 1 L9.2 8.6 H0.8 Z" fill="currentColor" />
    case 'critical':
      return <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="currentColor" />
    case 'idle':
      return <rect x="0.8" y="3.4" width="8.4" height="3.2" rx="0.6" fill="currentColor" />
    case 'unknown':
      return <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    case 'planned':
      return (
        <circle
          cx="5"
          cy="5"
          r="3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="1.6 1.6"
        />
      )
  }
}
