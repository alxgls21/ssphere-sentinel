import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import { createTransport } from './transport'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const failure = (status: number, code: string, message = 'Nope.') =>
  json({ error: { code, message } }, status)
const session = (csrfToken = 'tok-1') => json({ authenticated: false, csrfToken })

type Call = [string, RequestInit]
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init ?? {}])
    const next = answers.shift()
    if (next === undefined) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}
const header = (call: Call | undefined, name: string) =>
  (call?.[1].headers as Record<string, string> | undefined)?.[name]

describe('requests', () => {
  it('stays on the same origin with the session cookie, and never reads from a cache', async () => {
    const { fetchImpl, calls } = fakeFetch(json({ customers: [], sites: [] }))
    await createTransport({ fetchImpl }).get('scope/')
    expect(calls[0]?.[0]).toBe('/api/v1/console/scope/')
    expect(calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
    expect(header(calls[0], 'Accept')).toBe('application/json')
    expect(header(calls[0], 'X-CSRFToken')).toBeUndefined()
  })

  it('puts query values in the query string, encoded, and skips undefined ones', async () => {
    const { fetchImpl, calls } = fakeFetch(json({}))
    await createTransport({ fetchImpl }).get('x/', { query: { q: 'a b&c', page: undefined } })
    expect(calls[0]?.[0]).toBe('/api/v1/console/x/?q=a+b%26c')
  })
})

describe('CSRF', () => {
  it('sends the token the server last gave on every write', async () => {
    const { fetchImpl, calls } = fakeFetch(session('tok-A'), json({ ok: true }))
    const transport = createTransport({ fetchImpl })
    await transport.get('session/')
    await transport.post('auth/logout/')
    expect(header(calls[1], 'X-CSRFToken')).toBe('tok-A')
    expect(header(calls[1], 'Content-Type')).toBe('application/json')
    expect(calls[1]?.[1].method).toBe('POST')
  })

  it('asks for a token before its first write when it has none', async () => {
    const { fetchImpl, calls } = fakeFetch(session('tok-B'), json({ ok: true }))
    await createTransport({ fetchImpl }).post('auth/login/', { username: 'a', password: 'b' })
    expect(calls.map(([url]) => url)).toEqual([
      '/api/v1/console/session/',
      '/api/v1/console/auth/login/',
    ])
    expect(header(calls[1], 'X-CSRFToken')).toBe('tok-B')
    expect(calls[1]?.[1].body).toBe(JSON.stringify({ username: 'a', password: 'b' }))
  })

  it('follows a rotated token from any later answer', async () => {
    const { fetchImpl, calls } = fakeFetch(session('old'), session('rotated'), json({}))
    const transport = createTransport({ fetchImpl })
    await transport.get('session/')
    await transport.post('auth/login/', {})
    await transport.post('auth/logout/')
    expect(header(calls[2], 'X-CSRFToken')).toBe('rotated')
  })

  it('refreshes a refused token and sends the write once more, only once', async () => {
    const { fetchImpl, calls } = fakeFetch(
      session('stale'),
      failure(403, 'csrf_failed'),
      session('fresh'),
      json({ ok: true }),
    )
    const transport = createTransport({ fetchImpl })
    await transport.get('session/')
    await expect(transport.post('auth/logout/')).resolves.toEqual({ ok: true })
    expect(header(calls[3], 'X-CSRFToken')).toBe('fresh')

    const again = fakeFetch(
      session('a'),
      failure(403, 'csrf_failed'),
      session('b'),
      failure(403, 'csrf_failed'),
    )
    const second = createTransport({ fetchImpl: again.fetchImpl })
    await second.get('session/')
    await expect(second.post('auth/logout/')).rejects.toMatchObject({ code: 'csrf_failed' })
    expect(again.calls).toHaveLength(4)
  })
})

describe('errors', () => {
  it('turns an API error into an ApiError with its status, code and message', async () => {
    const { fetchImpl } = fakeFetch(failure(404, 'not_found', 'Not found.'))
    await expect(createTransport({ fetchImpl }).get('x/')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'not_found',
      message: 'Not found.',
    })
  })

  it('reports an expired session to the app, once per request, and still rejects', async () => {
    const onUnauthenticated = vi.fn()
    const { fetchImpl } = fakeFetch(failure(401, 'unauthenticated', 'Sign in to continue.'))
    await expect(
      createTransport({ fetchImpl, onUnauthenticated }).get('scope/'),
    ).rejects.toMatchObject({ status: 401 })
    expect(onUnauthenticated).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a wrong password for an expired session', async () => {
    const onUnauthenticated = vi.fn()
    const { fetchImpl } = fakeFetch(session(), failure(401, 'invalid_credentials', 'Wrong.'))
    await expect(
      createTransport({ fetchImpl, onUnauthenticated }).post('auth/login/', {}),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(onUnauthenticated).not.toHaveBeenCalled()
  })

  it('reports an account that may not use the console', async () => {
    const onForbidden = vi.fn()
    const { fetchImpl } = fakeFetch(failure(403, 'forbidden'))
    await expect(createTransport({ fetchImpl, onForbidden }).get('scope/')).rejects.toBeInstanceOf(
      ApiError,
    )
    expect(onForbidden).toHaveBeenCalledTimes(1)
  })

  it('does not trust a body that is not the API error shape (a proxy page, an empty 502)', async () => {
    const html = new Response('<html>Bad gateway</html>', { status: 502 })
    const { fetchImpl } = fakeFetch(html)
    const error = await createTransport({ fetchImpl })
      .get('x/')
      .catch((e: unknown) => e)
    expect(error).toMatchObject({
      status: 502,
      code: null,
      message: expect.stringContaining('502'),
    })
    expect((error as Error).message).not.toContain('Bad gateway')
  })

  it('says so when the server cannot be reached', async () => {
    const { fetchImpl } = fakeFetch(new TypeError('Failed to fetch'))
    await expect(createTransport({ fetchImpl }).get('x/')).rejects.toMatchObject({
      status: null,
      code: 'network',
    })
  })

  it('gives up on a server that never answers', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch
    await expect(createTransport({ fetchImpl, timeoutMs: 20 }).get('x/')).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('lets a caller cancel its own request without it becoming an error to show', async () => {
    const controller = new AbortController()
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch
    const pending = createTransport({ fetchImpl }).get('x/', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an answer that is not JSON', async () => {
    const { fetchImpl } = fakeFetch(new Response('ok', { status: 200 }))
    await expect(createTransport({ fetchImpl }).get('x/')).rejects.toMatchObject({
      code: 'bad_response',
    })
  })
})
