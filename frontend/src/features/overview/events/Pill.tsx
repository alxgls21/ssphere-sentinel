import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

const PILL_TONE = {
  neutral: 'border-border-control',
  fresh: 'border-primary-line text-primary',
} as const

/** A small button floating over a list. Opaque, so it never competes with the text under it. */
export function Pill({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'button'> & { tone?: keyof typeof PILL_TONE }) {
  return (
    <button
      type="button"
      className={cn(
        'type-tag absolute z-10 inline-flex h-6 items-center rounded-sm border bg-raised px-2 whitespace-nowrap text-fg',
        'transition-colors duration-(--dur-fast) hover:bg-hover pointer-coarse:h-(--hit)',
        PILL_TONE[tone],
        className,
      )}
      {...props}
    />
  )
}
