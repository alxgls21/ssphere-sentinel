import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface ChipProps extends Omit<
  ComponentProps<'button'>,
  'children' | 'onClick' | 'aria-pressed'
> {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  /** Number of items the filter matches ("CRIT 4"). */
  count?: number | string
  /** A glyph or icon before the label; keep it decorative (the label names the chip). */
  leading?: ReactNode
  children: ReactNode
}

/** A toggleable filter chip (24px; 44px on coarse pointers). */
export function Chip({
  pressed,
  onPressedChange,
  count,
  leading,
  className,
  type = 'button',
  children,
  ...props
}: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        'type-tag inline-flex h-6 items-center gap-1.5 rounded-sm border border-border-control px-2 whitespace-nowrap pointer-coarse:h-(--hit)',
        'transition-colors duration-(--dur-fast) disabled:text-fg-disabled',
        pressed
          ? 'bg-primary-tint text-primary'
          : 'text-fg-muted enabled:hover:bg-hover enabled:hover:text-fg',
        className,
      )}
      {...props}
    >
      {leading}
      <span>{children}</span>
      {count != null ? (
        <>
          {/* Flex layout ignores this space; the accessible name reads "CRIT 4", not "CRIT4". */}{' '}
          <span className="tnum">{count}</span>
        </>
      ) : null}
    </button>
  )
}
