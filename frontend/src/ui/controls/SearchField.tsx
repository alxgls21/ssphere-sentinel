import { Search, X } from 'lucide-react'
import { useId, useRef, type ChangeEvent } from 'react'
import { cn } from '@/lib/cn'

export interface SearchFieldProps {
  /** The accessible name (also the placeholder). */
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

/**
 * A search box: a native `type="search"` input (so the platform gives the
 * keyboard, the mobile keypad and Escape-to-clear) with our own icon and a
 * visible clear button that works on touch.
 */
export function SearchField({ label, value, onChange, placeholder, className }: SearchFieldProps) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className={cn('relative inline-flex min-w-0', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-faint"
        strokeWidth={1.5}
      />
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        placeholder={placeholder ?? label}
        autoComplete="off"
        spellCheck={false}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        className={cn(
          'type-data h-(--ctl-h) w-full min-w-0 rounded-sm border border-border-control bg-bg pr-7 pl-7 text-fg',
          'transition-colors duration-(--dur-fast) placeholder:text-fg-faint hover:bg-hover focus-visible:bg-bg',
          // The clear control is ours: hide the browser's.
          '[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden',
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange('')
            // The button is about to disappear: keep the keyboard where the operator was typing.
            inputRef.current?.focus()
          }}
          className="absolute top-1/2 right-0.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg pointer-coarse:size-(--hit)"
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
        </button>
      ) : null}
    </div>
  )
}
