import type { ReactNode, Ref } from 'react'
import { Notice } from '@/ui/states'

interface FormNoticeProps {
  /** The fields that are wrong, by the names the form shows, each explained under its field. */
  invalid: readonly string[]
  /** What is wrong with the whole, or why the server refused, one sentence per line. */
  lines: readonly string[]
  /** The word of a refusal: "NOT SAVED", "NOT ADDED", "NOT DELETED". */
  word?: string
  /** Takes the focus after a failed submission, so what happened is read next. */
  ref?: Ref<HTMLDivElement>
  /** Something to say instead when nothing went wrong (a notice of what was done). */
  children?: ReactNode
}

/**
 * The summary on top of a form after a submission: which fields are wrong and what the server
 * said, in one alert; nothing when there is nothing to say. The container is focusable, so a form
 * can move the keyboard here on failure.
 */
export function FormNotice({ invalid, lines, word = 'NOT SAVED', ref, children }: FormNoticeProps) {
  const failed = invalid.length > 0 || lines.length > 0
  return (
    <div ref={ref} tabIndex={-1} className="flex flex-col gap-2 outline-none">
      {failed ? (
        <Notice status="critical" word={word} live="alert">
          {invalid.length > 0 ? (
            <p>
              Some values are not valid: {invalid.join(', ')}. Each is explained under its field.
            </p>
          ) : null}
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Notice>
      ) : (
        children
      )}
    </div>
  )
}
