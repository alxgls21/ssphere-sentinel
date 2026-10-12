/** Failure talking to (or simulated for) the Sentinel API. */
export class ApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
