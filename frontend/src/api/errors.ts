/** Failure talking to (or simulated for) the Sentinel API. */
export class ApiError extends Error {
  readonly status: number | null
  /** The machine-readable error code of a real API answer (`unauthenticated`, ...); null when there is none. */
  readonly code: string | null

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
