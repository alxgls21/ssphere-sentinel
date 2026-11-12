import { useState, type RefObject } from 'react'
import { describeWriteFailure, summaryOf, type FormFailure } from '@/lib/forms'

export type FieldErrors<Field extends string> = Partial<Record<Field, readonly string[]>>

export interface SaveForm<Field extends string> {
  /** What is wrong with each field: the form's own checks, then the server's answer. */
  errors: FieldErrors<Field>
  /** The names of the fields that are wrong, for the summary on top. */
  invalid: Field[]
  /** The general problems and the server's message, for the summary on top. */
  lines: string[]
  /** The last refusal of the server as a whole (its code decides what a page says). */
  failure: FormFailure | null
  saving: boolean
  /** The operator edited something: the old problems no longer apply. */
  touched: () => void
  /**
   * Checks the draft here, then runs the write. Resolves true when it succeeded; on failure the
   * errors are set, `failed` is announced and the summary takes the focus.
   */
  submit: (
    found: FieldErrors<Field>,
    action: () => Promise<void>,
    words: { failed: string },
  ) => Promise<boolean>
}

const hasAny = <Field extends string>(errors: FieldErrors<Field>): boolean =>
  Object.values(errors).some(
    (messages) => ((messages as readonly string[] | undefined)?.length ?? 0) > 0,
  )

/**
 * What every form that writes to the console API does around a save: the checks made here, the
 * server's own answer field by field, the summary that takes the focus, and the announcement.
 * `fields` names the fields the form draws an error under; any other field the server names is
 * listed on top, so none is lost. `summary` is the element on top of the form (the component
 * owns the ref): it takes the focus after a failed submission.
 */
export function useSaveForm<Field extends string>(
  fields: readonly Field[],
  announce: ((text: string) => void) | undefined,
  summary: RefObject<HTMLDivElement | null>,
): SaveForm<Field> {
  const [clientErrors, setClientErrors] = useState<FieldErrors<Field>>({})
  const [failure, setFailure] = useState<FormFailure | null>(null)
  const [saving, setSaving] = useState(false)
  const focusSummary = () => requestAnimationFrame(() => summary.current?.focus())

  const errors: FieldErrors<Field> = {
    ...clientErrors,
    ...((failure?.fields ?? {}) as FieldErrors<Field>),
  }
  const invalid = (Object.entries(errors) as [Field, readonly string[] | undefined][])
    .filter(([, messages]) => (messages?.length ?? 0) > 0)
    .map(([name]) => name)

  return {
    errors,
    invalid,
    lines: summaryOf(failure),
    failure,
    saving,
    touched: () => {
      setClientErrors({})
      setFailure(null)
    },
    submit: async (found, action, words) => {
      if (hasAny(found)) {
        setClientErrors(found)
        announce?.('Some values are not valid.')
        focusSummary()
        return false
      }
      setSaving(true)
      setFailure(null)
      try {
        await action()
        return true
      } catch (error) {
        setFailure(describeWriteFailure(error, fields))
        announce?.(words.failed)
        focusSummary()
        return false
      } finally {
        setSaving(false)
      }
    },
  }
}
