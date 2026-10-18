import { cn } from '@/lib/cn'
import { STATUS_FRAME } from '@/ui/status'

/** The control's own look: the console's height and border, and the critical line when it is invalid. */
export function controlClass(invalid = false, className?: string): string {
  return cn(
    'type-data h-(--ctl-h) w-full min-w-0 rounded-sm border bg-bg px-2 text-fg',
    'transition-colors duration-(--dur-fast) placeholder:text-fg-faint hover:bg-hover focus-visible:bg-bg',
    'disabled:border-border-strong disabled:text-fg-disabled disabled:hover:bg-bg',
    invalid ? STATUS_FRAME.critical : 'border-border-control',
    className,
  )
}
