import { ChevronDown } from 'lucide-react'
import { useId, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { STATUS_TEXT, StatusGlyph } from '@/ui/status'
import { controlClass } from './controlClass'

/** What a form control needs from its field: its id, and the ids of what describes it. */
export interface FieldAria {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
}

export interface FieldProps {
  label: string
  /** Quiet help under the control. */
  hint?: ReactNode
  /** What is wrong with the value, as the server or the form says it. Several are listed. */
  error?: readonly string[] | string | null
  className?: string
  children: (aria: FieldAria) => ReactNode
}

const asList = (error: FieldProps['error']): readonly string[] =>
  error === null || error === undefined ? [] : typeof error === 'string' ? [error] : error

/**
 * A labelled control with its hint and its errors: the label is a real <label>, the hint and the
 * errors are named by aria-describedby, and an error is a mark and words, never color alone.
 */
export function Field({ label, hint, error, className, children }: FieldProps) {
  const id = useId()
  const errors = asList(error)
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, errors.length > 0 ? errorId : null]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="type-label text-fg-muted">
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': errors.length > 0 ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="type-body text-fg-faint">
          {hint}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <ul id={errorId} className={cn('type-body flex flex-col gap-0.5', STATUS_TEXT.critical)}>
          {errors.map((message) => (
            <li key={message} className="flex items-start gap-1.5">
              <StatusGlyph status="critical" size={10} className="mt-1" />
              <span>
                <span className="sr-only">Error: </span>
                {message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

type InputProps = Omit<ComponentProps<'input'>, 'id' | 'onChange' | 'value'>

/** A labelled single-line input with its hint and errors. */
export function FieldInput({
  value,
  onChange,
  input,
  ...field
}: Omit<FieldProps, 'children'> & {
  value: string
  onChange: (value: string) => void
  input?: InputProps
}) {
  return (
    <Field {...field}>
      {(aria) => (
        <input
          {...input}
          {...aria}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={controlClass(aria['aria-invalid'] === true, input?.className)}
        />
      )}
    </Field>
  )
}

/** A labelled multi-line input with its hint and errors. */
export function FieldTextArea({
  value,
  onChange,
  textarea,
  ...field
}: Omit<FieldProps, 'children'> & {
  value: string
  onChange: (value: string) => void
  textarea?: Omit<ComponentProps<'textarea'>, 'id' | 'onChange' | 'value'>
}) {
  return (
    <Field {...field}>
      {(aria) => (
        <textarea
          rows={3}
          {...textarea}
          {...aria}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            controlClass(aria['aria-invalid'] === true),
            'h-auto min-h-16 resize-y py-1.5',
            textarea?.className,
          )}
        />
      )}
    </Field>
  )
}

export interface FieldSelectOption<T extends string> {
  value: T
  label: string
}

/** A labelled native select (the platform's keyboard and picker) with its hint and errors. */
export function FieldSelect<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ...field
}: Omit<FieldProps, 'children'> & {
  value: T
  onChange: (value: T) => void
  options: readonly FieldSelectOption<T>[]
  disabled?: boolean
}) {
  return (
    <Field {...field}>
      {(aria) => (
        <span className="relative inline-flex min-w-0">
          <select
            {...aria}
            value={value}
            disabled={disabled}
            // The DOM hands back a string; the options are the only values it can hold.
            onChange={(event) => onChange(event.target.value as T)}
            className={cn(
              controlClass(aria['aria-invalid'] === true),
              'appearance-none truncate pr-7',
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
      )}
    </Field>
  )
}

interface CheckboxProps {
  label: string
  /** What switching it does, under the label. */
  description?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  error?: readonly string[] | string | null
  className?: string
}

/** A labelled checkbox (a switch of the form) with its description and errors. */
export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
  error,
  className,
}: CheckboxProps) {
  const id = useId()
  const errors = asList(error)
  const describedBy = [
    description ? `${id}-description` : null,
    errors.length > 0 ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy || undefined}
          aria-invalid={errors.length > 0 ? true : undefined}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-60 pointer-coarse:size-5"
        />
        <label
          htmlFor={id}
          className={cn('type-data-strong', disabled ? 'text-fg-disabled' : 'text-fg')}
        >
          {label}
        </label>
      </div>
      {description ? (
        <p id={`${id}-description`} className="type-body pl-6 text-fg-faint">
          {description}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <ul
          id={`${id}-error`}
          className={cn('type-body flex flex-col gap-0.5 pl-6', STATUS_TEXT.critical)}
        >
          {errors.map((message) => (
            <li key={message}>
              <span className="sr-only">Error: </span>
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export interface RadioChoice<T extends string> {
  value: T
  label: string
  /** What choosing it means, under the label. */
  hint?: string
}

interface RadioGroupProps<T extends string> {
  /** The question the choices answer. */
  legend: string
  name: string
  value: T
  onChange: (value: T) => void
  choices: readonly RadioChoice<T>[]
  disabled?: boolean
  error?: readonly string[] | string | null
  className?: string
}

/** One choice of several (native radios in a fieldset), each with its hint, and the errors of the set. */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  choices,
  disabled,
  error,
  className,
}: RadioGroupProps<T>) {
  const id = useId()
  const errors = asList(error)
  const errorId = `${id}-error`
  return (
    <fieldset className={cn('flex min-w-0 flex-col gap-2', className)} disabled={disabled}>
      <legend className="type-label text-fg-muted">{legend}</legend>
      {choices.map((choice) => {
        const choiceId = `${id}-${choice.value}`
        const describedBy = [
          choice.hint ? `${choiceId}-hint` : null,
          errors.length > 0 ? errorId : null,
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div key={choice.value} className="flex items-start gap-2">
            <input
              id={choiceId}
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              aria-describedby={describedBy || undefined}
              onChange={() => onChange(choice.value)}
              className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-60 pointer-coarse:size-5"
            />
            <div className="flex min-w-0 flex-col">
              <label
                htmlFor={choiceId}
                className={cn('type-data-strong', disabled ? 'text-fg-disabled' : 'text-fg')}
              >
                {choice.label}
              </label>
              {choice.hint ? (
                <p id={`${choiceId}-hint`} className="type-body text-fg-faint">
                  {choice.hint}
                </p>
              ) : null}
            </div>
          </div>
        )
      })}
      {errors.length > 0 ? (
        <ul id={errorId} className={cn('type-body flex flex-col gap-0.5', STATUS_TEXT.critical)}>
          {errors.map((message) => (
            <li key={message}>
              <span className="sr-only">Error: </span>
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  )
}
