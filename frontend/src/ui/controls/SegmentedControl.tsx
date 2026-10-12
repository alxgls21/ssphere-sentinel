import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Tooltip } from './Tooltip'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** Supplementary hint shown in a tooltip; the label must already make sense alone. */
  title?: string
}

export interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  'aria-label': string
  /**
   * radio: one choice that changes a view or a setting (role=radiogroup).
   * tabs:  switches between panels of content (role=tablist); the consumer owns the tabpanel.
   */
  variant?: 'radio' | 'tabs'
  /** md is 28px; sm is 24px for panel headers. Both grow to 44px on coarse pointers. */
  size?: 'md' | 'sm'
  className?: string
}

const SIZE = {
  md: { box: 'h-(--ctl-h)', segment: 'px-2.5' },
  sm: { box: 'h-6 pointer-coarse:h-(--hit)', segment: 'px-2' },
} as const

/**
 * Segmented choice with a roving tab stop: Tab enters on the selected segment,
 * Left/Right/Up/Down move AND select (wrapping), Home/End jump to the ends.
 * Moving selects because the segments are few and switching is cheap and
 * reversible, so there is no separate "confirm" step to learn.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  'aria-label': label,
  variant = 'radio',
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((option) => option.value === value)
  // With no matching value the first segment is still reachable by keyboard.
  const tabStop = selected === -1 ? 0 : selected

  const move = (event: KeyboardEvent, from: number) => {
    const last = options.length - 1
    let to: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        to = from === last ? 0 : from + 1
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        to = from === 0 ? last : from - 1
        break
      case 'Home':
        to = 0
        break
      case 'End':
        to = last
        break
      default:
        return
    }
    event.preventDefault()
    const next = options[to]
    if (!next) return
    buttons.current[to]?.focus()
    if (next.value !== value) onChange(next.value)
  }

  const [groupRole, itemRole] = variant === 'tabs' ? ['tablist', 'tab'] : ['radiogroup', 'radio']

  return (
    <div
      role={groupRole}
      aria-label={label}
      className={cn(
        'inline-flex divide-x divide-border-control rounded-sm border border-border-control',
        SIZE[size].box,
        className,
      )}
    >
      {options.map((option, index) => {
        const isSelected = index === selected
        const segment = (
          <button
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role={itemRole}
            aria-checked={variant === 'radio' ? isSelected : undefined}
            aria-selected={variant === 'tabs' ? isSelected : undefined}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => {
              if (!isSelected) onChange(option.value)
            }}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'type-data-strong inline-flex h-full items-center justify-center border-b-2 whitespace-nowrap transition-colors duration-(--dur-fast) focus-visible:-outline-offset-2',
              SIZE[size].segment,
              isSelected
                ? 'border-b-primary bg-primary-tint text-primary'
                : 'border-b-transparent text-fg-muted hover:bg-hover hover:text-fg',
            )}
          >
            {option.label}
          </button>
        )
        return (
          <Tooltip key={option.value} content={option.title}>
            {segment}
          </Tooltip>
        )
      })}
    </div>
  )
}
