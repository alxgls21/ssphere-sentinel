export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
/** md is 28px; sm is 24px for panel headers and banners. Both grow to 44px on coarse pointers. */
export type ButtonSize = 'md' | 'sm'

/**
 * Shared by Button, IconButton and the Menu trigger so one change restyles all
 * of them. Class names are written out in full so Tailwind's scanner sees them.
 */
const BASE = [
  'type-data-strong inline-flex items-center justify-center gap-1.5 rounded-sm border',
  'whitespace-nowrap transition-colors duration-(--dur-fast)',
  // Disabled is legible but plainly inert. aria-disabled gets the same look for buttons that stay
  // focusable so they can explain themselves; both variants sort after hover/active in the CSS.
  'disabled:border-border-strong disabled:bg-transparent disabled:text-fg-disabled',
  'aria-disabled:border-border-strong aria-disabled:bg-transparent aria-disabled:text-fg-disabled',
].join(' ')

const VARIANT: Record<ButtonVariant, string> = {
  // Solid cyan with bg-colored ink (11.8:1).
  primary:
    'bg-primary text-bg border-primary hover:bg-primary-hover hover:border-primary-hover active:bg-primary-press',
  secondary: 'bg-transparent text-fg border-border-control hover:bg-hover active:bg-primary-tint',
  ghost:
    'bg-transparent text-fg-muted border-transparent hover:bg-hover hover:text-fg active:bg-primary-tint',
}

/** Label buttons grow with their text; square (icon-only) buttons are exactly one control wide. */
const SIZE = {
  md: {
    label: 'h-(--ctl-h) min-w-(--ctl-h) px-2.5',
    square: 'size-(--ctl-h) shrink-0',
  },
  sm: {
    label: 'h-6 min-w-6 px-2 pointer-coarse:h-(--hit) pointer-coarse:min-w-(--hit)',
    square: 'size-6 shrink-0 pointer-coarse:size-(--hit)',
  },
} as const

export function buttonStyle(
  variant: ButtonVariant,
  { shape = 'label', size = 'md' }: { shape?: 'label' | 'square'; size?: ButtonSize } = {},
): string {
  return `${BASE} ${SIZE[size][shape]} ${VARIANT[variant]}`
}
