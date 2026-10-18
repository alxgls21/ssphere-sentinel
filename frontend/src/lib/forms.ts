import { ApiError } from '@/api/errors'

/**
 * What a rejected write says to a form: which fields are wrong and why (the API's own words, per
 * field name), what is wrong with the whole, and a message for everything else. A message of the
 * server is its own safe text; a failure that is no answer of the server never carries its internals.
 */
export interface FormFailure {
  /** By the form's own field names. */
  fields: Readonly<Record<string, readonly string[]>>
  /** Problems of the whole form (`nonField`), and of fields the form does not show. */
  general: readonly string[]
  /** The status the server answered, or null when there was no answer. */
  status: number | null
  code: string | null
  /** One sentence for a failure that is not a field's: refused, gone, conflict, no connection. */
  message: string | null
}

const NO_ANSWER = new Set(['network', 'timeout'])

/**
 * `shown` names the fields the form draws an error under. Any other field the server names, and
 * `nonField`, are listed as general problems, so none is lost.
 */
export function describeWriteFailure(error: unknown, shown: readonly string[]): FormFailure {
  if (!(error instanceof ApiError)) {
    return {
      fields: {},
      general: [],
      status: null,
      code: null,
      message: 'The change could not be saved.',
    }
  }
  const fields: Record<string, readonly string[]> = {}
  const general: string[] = []
  for (const [name, messages] of Object.entries(error.fields ?? {})) {
    if (shown.includes(name)) fields[name] = messages
    else
      general.push(
        ...messages.map((message) => (name === 'nonField' ? message : `${name}: ${message}`)),
      )
  }
  if (error.code === 'validation_error') {
    return { fields, general, status: error.status, code: error.code, message: null }
  }
  let message: string
  if (error.code !== null && NO_ANSWER.has(error.code)) {
    message =
      'The server could not be reached. Nothing is known to have changed: reload to check, then try again.'
  } else if (error.status === 403) {
    message = 'This account may not make this change.'
  } else if (error.status === 404) {
    message = 'It no longer exists, or you may no longer see it.'
  } else {
    message = error.message
  }
  return { fields, general, status: error.status, code: error.code, message }
}

/** The first line a form says on top: the general problems, or the message, or nothing. */
export function summaryOf(failure: FormFailure | null): string[] {
  if (failure === null) return []
  return [...failure.general, ...(failure.message ? [failure.message] : [])]
}
