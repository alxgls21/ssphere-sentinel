import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'
import { buttonStyle, type ButtonSize, type ButtonVariant } from './buttonStyle'

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
}

/**
 * 28px (44px on coarse pointers), 2px radius, mono label. `disabled` removes
 * the button from the tab order; use `aria-disabled` instead when it must stay
 * focusable to explain why it is unavailable (it then also stays clickable, so
 * the handler decides what to say).
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return <button type={type} className={cn(buttonStyle(variant, { size }), className)} {...props} />
}
