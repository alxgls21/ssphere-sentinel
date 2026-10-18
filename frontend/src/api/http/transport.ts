import { ApiError } from '../errors'

/**
 * The one place that talks HTTP to the console API: same-origin requests with
 * the session cookie, the CSRF header on every write, one error shape.
 *
 * Authentication failures are reported through callbacks, so every request
 * handles an expired session the same way (see app/auth).
 */

export const API_BASE = '/api/v1/console/'
const REQUEST_TIMEOUT_MS = 15_000

export interface TransportOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** A request that needs a session came back 401 `unauthenticated`. */
  onUnauthenticated?: () => void
  /** The session is valid but the account may not use the console (403 `forbidden`). */
  onForbidden?: () => void
}

export interface RequestInitLite {
  signal?: AbortSignal
  query?: Readonly<Record<string, string | undefined>>
}

export interface Transport {
  get<T>(path: string, init?: RequestInitLite): Promise<T>
  post<T>(path: string, body?: unknown, init?: RequestInitLite): Promise<T>
  put<T>(path: string, body: unknown, init?: RequestInitLite): Promise<T>
  patch<T>(path: string, body: unknown, init?: RequestInitLite): Promise<T>
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; fields?: unknown }
}

/** The most a client will be told to wait: a larger or odd `Retry-After` is not believed. */
const MAX_RETRY_AFTER_SECONDS = 3600

/** `Retry-After` as the console API sends it: whole seconds. Anything else is no advice at all. */
function retryAfter(response: Response): number | null {
  const value = response.headers?.get('Retry-After')
  if (value === null || value === undefined || !/^\d{1,5}$/.test(value.trim())) return null
  return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS)
}

/** What is wrong with each field, as a `validation_error` says it: only lists of text are kept. */
function fieldErrors(value: unknown): Record<string, string[]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields: Record<string, string[]> = {}
  for (const [name, messages] of Object.entries(value)) {
    if (Array.isArray(messages)) {
      const texts = messages.filter((message): message is string => typeof message === 'string')
      if (texts.length > 0) fields[name] = texts
    }
  }
  return Object.keys(fields).length > 0 ? fields : null
}

const isAbort = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error.name === 'AbortError' || error.name === 'TimeoutError')

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readError(response: Response): Promise<ApiError> {
  let body: ErrorBody | null = null
  try {
    body = (await response.json()) as ErrorBody
  } catch {
    // A proxy's HTML page, a gateway timeout, an empty body: not an API answer.
  }
  const code = typeof body?.error?.code === 'string' ? body.error.code : null
  const message = typeof body?.error?.message === 'string' ? body.error.message : null
  if (code === null || message === null) {
    return new ApiError(`The server is unavailable (HTTP ${response.status}).`, response.status)
  }
  return new ApiError(message, response.status, code, {
    fields: fieldErrors(body?.error?.fields),
    retryAfterSeconds: response.status === 429 ? retryAfter(response) : null,
  })
}

export function createTransport({
  baseUrl = API_BASE,
  fetchImpl = (input, init) => fetch(input, init),
  timeoutMs = REQUEST_TIMEOUT_MS,
  onUnauthenticated,
  onForbidden,
}: TransportOptions = {}): Transport {
  let csrfToken: string | null = null

  const url = (path: string, query?: RequestInitLite['query']) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, value)
    }
    const text = params.toString()
    return `${baseUrl}${path}${text ? `?${text}` : ''}`
  }

  async function send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    body: unknown,
    init: RequestInitLite | undefined,
    retriedCsrf: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
      // The token comes from the session answer; without it Django would refuse the write.
      if (csrfToken === null) await send<unknown>('GET', 'session/', undefined, init, true)
      if (csrfToken !== null) headers['X-CSRFToken'] = csrfToken
    }
    let response: Response
    try {
      response = await fetchImpl(url(path, init?.query), {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: withTimeout(init?.signal, timeoutMs),
      })
    } catch (error) {
      if (init?.signal?.aborted) throw error
      if (isAbort(error)) throw new ApiError('The server took too long to answer.', null, 'timeout')
      throw new ApiError('Cannot reach the server.', null, 'network')
    }

    if (!response.ok) {
      const error = await readError(response)
      if (error.code === 'csrf_failed' && method !== 'GET' && !retriedCsrf) {
        // The token went stale (the cookie was rotated or cleared): fetch a fresh one and send once more.
        csrfToken = null
        return send<T>(method, path, body, init, true)
      }
      if (error.status === 401 && error.code === 'unauthenticated') onUnauthenticated?.()
      if (error.status === 403 && error.code === 'forbidden') onForbidden?.()
      throw error
    }
    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new ApiError('The server sent an unreadable response.', response.status, 'bad_response')
    }
    // The session, sign-in and sign-out answers carry the CSRF token for the writes that follow.
    const token = (data as { csrfToken?: unknown } | null)?.csrfToken
    if (typeof token === 'string' && token !== '') csrfToken = token
    return data as T
  }

  return {
    get: (path, init) => send('GET', path, undefined, init, false),
    post: (path, body, init) => send('POST', path, body, init, false),
    put: (path, body, init) => send('PUT', path, body, init, false),
    patch: (path, body, init) => send('PATCH', path, body, init, false),
  }
}
