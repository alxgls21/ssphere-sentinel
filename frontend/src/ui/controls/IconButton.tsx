import type { LucideIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'
import { buttonStyle, type ButtonVariant } from './buttonStyle'
import { Tooltip } from './Tooltip'

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children' | 'aria-label'> {
  /** Required: with no visible text this is the button's only name, and the tooltip text. */
  'aria-label': string
  icon: LucideIcon
  /** Shortcut text appended to the tooltip: "Collapse sidebar ([)". */
  shortcut?: string
  variant?: ButtonVariant
}

/** A square icon-only button (16px icon, 1.5 stroke) whose tooltip names it and lists its shortcut. */
export function IconButton({
  'aria-label': label,
  icon: Icon,
  shortcut,
  variant = 'secondary',
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
      <button
        type={type}
        aria-label={label}
        className={cn(buttonStyle(variant, { shape: 'square' }), className)}
        {...props}
      >
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
