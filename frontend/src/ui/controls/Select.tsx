import { ChevronDown } from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/cn'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SelectProps<T extends string> {
  /** The accessible name; shown beside the control unless `hideLabel` is set. */
  label: string
  /** Keep the label as the accessible name but do not draw it (the selected option says enough). */
  hideLabel?: boolean
  value: T
  onChange: (value: T) => void
  options: readonly SelectOption<T>[]
  disabled?: boolean
  /** Sizes and places the whole control (label and field); the field fills what the label leaves. */
  className?: string
}

/**
 * A styled native <select>: the platform supplies the keyboard behavior, the
 * mobile picker and the popup, so there is nothing to re-implement or get wrong.
 */
export function Select<T extends string>({
  label,
  hideLabel = false,
  value,
  onChange,
  options,
  disabled,
  className,
}: SelectProps<T>) {
  const id = useId()
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <label
        htmlFor={id}
        className={hideLabel ? 'sr-only' : 'type-label whitespace-nowrap text-fg-muted'}
      >
        {label}
      </label>
      <span className="relative inline-flex min-w-0 flex-1">
        <select
          id={id}
          value={value}
          disabled={disabled}
          // The DOM hands back a string; the options are the only values it can hold.
          onChange={(event) => onChange(event.target.value as T)}
          className={cn(
            'type-data-strong h-(--ctl-h) w-full min-w-0 appearance-none truncate rounded-sm border border-border-control bg-bg pr-7 pl-2.5 text-fg',
            'transition-colors duration-(--dur-fast) enabled:hover:bg-hover disabled:border-border-strong disabled:text-fg-disabled',
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-1/2 right-2 -translate-y-1/2',
            disabled ? 'text-fg-disabled' : 'text-fg-muted',
          )}
        />
      </span>
    </div>
  )
}
