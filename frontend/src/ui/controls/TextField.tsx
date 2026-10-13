import { useId, type ComponentProps } from 'react'
import { cn } from '@/lib/cn'

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'id' | 'onChange'> {
  label: string
  value: string
  onChange: (value: string) => void
}

/** A labelled single-line input, in the console's control height and border. */
export function TextField({ label, value, onChange, className, ref, ...props }: TextFieldProps) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="type-label text-fg-muted">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'type-data h-(--ctl-h) w-full min-w-0 rounded-sm border border-border-control bg-bg px-2 text-fg',
          'transition-colors duration-(--dur-fast) placeholder:text-fg-faint hover:bg-hover focus-visible:bg-bg disabled:text-fg-disabled',
          className,
        )}
        {...props}
      />
    </div>
  )
}
