/** Failure talking to (or simulated for) the Sentinel API. */
export class ApiError extends Error {
  readonly status: number | null
  /** The machine-readable error code of a real API answer (`unauthenticated`, ...); null when there is none. */
  readonly code: string | null
  /** For a `validation_error`: what is wrong with each field of the request, by field name. Otherwise null. */
  readonly fields: Readonly<Record<string, readonly string[]>> | null
  /** For a 429: the seconds the server asked to wait (`Retry-After`). Otherwise null. */
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    status: number | null = null,
    code: string | null = null,
    details: {
      fields?: Readonly<Record<string, readonly string[]>> | null
      retryAfterSeconds?: number | null
    } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = details.fields ?? null
    this.retryAfterSeconds = details.retryAfterSeconds ?? null
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
