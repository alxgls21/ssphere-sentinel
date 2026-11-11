import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('never sends the token on a read, even while it holds one', async () => {
    const { fetchImpl, calls } = fakeFetch(session('tok-R'), json({}), json({ ok: true }))
    const transport = createTransport({ fetchImpl })
    await transport.get('session/')
    await transport.get('scope/')
    await transport.post('auth/logout/')
    expect(header(calls[1], 'X-CSRFToken')).toBeUndefined()
    // It did hold the token: the write that follows carries it.
    expect(header(calls[2], 'X-CSRFToken')).toBe('tok-R')
  })

  it('does not fetch a new token and repeat a read that answers csrf_failed', async () => {
    const { fetchImpl, calls } = fakeFetch(session('tok-1'), failure(403, 'csrf_failed'))
    const transport = createTransport({ fetchImpl })
    await transport.get('session/')
    await expect(transport.get('scope/')).rejects.toMatchObject({ code: 'csrf_failed' })
    expect(calls).toHaveLength(2)
  })

  it('does not send a write when the token it needs cannot be fetched', async () => {
    const offline = fakeFetch(new TypeError('Failed to fetch'))
    await expect(
      createTransport({ fetchImpl: offline.fetchImpl }).post('auth/logout/'),
    ).rejects.toMatchObject({ code: 'network' })
    expect(offline.calls.map(([url]) => url)).toEqual(['/api/v1/console/session/'])

    const broken = fakeFetch(failure(500, 'internal_error', 'Boom.'))
    await expect(
      createTransport({ fetchImpl: broken.fetchImpl }).post('auth/logout/'),
    ).rejects.toMatchObject({ status: 500, code: 'internal_error' })
    expect(broken.calls.map(([url]) => url)).toEqual(['/api/v1/console/session/'])
  })

  it('keeps the token it has when a later answer carries an empty or odd one', async () => {
    const { fetchImpl, calls } = fakeFetch(
      session('tok-K'),
      json({ csrfToken: '' }),
      json({ csrfToken: 42 }),
      json({ csrfToken: null }),
      json({ ok: true }),
    )
    const transport = createTransport({ fetchImpl })
    await transport.get('session/')
    await transport.get('a/')
    await transport.get('b/')
    await transport.get('c/')
    await transport.post('auth/logout/')
    expect(header(calls[4], 'X-CSRFToken')).toBe('tok-K')
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

  it('reports a session only for the exact status and code: nothing else ends or re-reads it', async () => {
    const onUnauthenticated = vi.fn()
    const onForbidden = vi.fn()
    const { fetchImpl } = fakeFetch(
      failure(403, 'permission_denied'),
      failure(400, 'forbidden'),
      failure(403, 'unauthenticated'),
      failure(400, 'unauthenticated'),
    )
    const transport = createTransport({ fetchImpl, onUnauthenticated, onForbidden })
    for (const path of ['a/', 'b/', 'c/', 'd/']) {
      await expect(transport.get(path)).rejects.toBeInstanceOf(ApiError)
    }
    expect(onForbidden).not.toHaveBeenCalled()
    expect(onUnauthenticated).not.toHaveBeenCalled()
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

  /**
   * The headers arrive in time and the body is still coming when the request is cut: a browser then
   * rejects the body read with the signal's reason, which is what this answer does.
   */
  const slowBody = ((_url: string, init: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () =>
        new Promise((_resolve, reject) => {
          const { signal } = init
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    })) as unknown as typeof fetch

  it('reports a timeout while the answer is still arriving as a timeout, not as an unreadable answer', async () => {
    await expect(
      createTransport({ fetchImpl: slowBody, timeoutMs: 20 }).get('x/'),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'timeout' })
  })

  it('lets a caller cancel its own request while the answer is arriving, without it becoming an error to show', async () => {
    const controller = new AbortController()
    const pending = createTransport({ fetchImpl: slowBody }).get('x/', {
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  /** The same when the answer is a refusal: its status has arrived, the body that explains it has not. */
  const slowRefusal = (async (url: string, init: RequestInit) => ({
    ...(await slowBody(url, init)),
    ok: false,
    status: 401,
  })) as unknown as typeof fetch

  it('reports a timeout while a refusal is still arriving as a timeout, not as a server that is down', async () => {
    await expect(
      createTransport({ fetchImpl: slowRefusal, timeoutMs: 20 }).get('x/'),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'timeout' })
  })

  it('lets a caller cancel its own request while a refusal is arriving, without it becoming an error to show', async () => {
    const controller = new AbortController()
    const pending = createTransport({ fetchImpl: slowRefusal }).get('x/', {
      signal: controller.signal,
    })
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

/**
 * AbortSignal.any is newer (Chrome 116, Firefox 124, Safari 17.4) than the oldest browsers the build
 * targets. There a request that carries the caller's signal, as every load of a page does, must still
 * be sent, still time out and still be cancelled by its caller.
 */
describe('a browser without AbortSignal.any', () => {
  const any = AbortSignal.any
  beforeEach(() => {
    Reflect.set(AbortSignal, 'any', undefined)
  })
  afterEach(() => {
    Reflect.set(AbortSignal, 'any', any)
  })

  const neverAnswers = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as unknown as typeof fetch

  it('still sends a request that carries the caller’s signal', async () => {
    const { fetchImpl, calls } = fakeFetch(json({ ok: true }))
    const answer = await createTransport({ fetchImpl }).get('x/', {
      signal: new AbortController().signal,
    })
    expect(answer).toEqual({ ok: true })
    expect(calls[0]?.[1].signal?.aborted).toBe(false)
  })

  it('still gives up on a server that never answers', async () => {
    await expect(
      createTransport({ fetchImpl: neverAnswers, timeoutMs: 20 }).get('x/', {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'timeout' })
  })

  it('still lets a caller cancel its own request', async () => {
    const controller = new AbortController()
    const pending = createTransport({ fetchImpl: neverAnswers }).get('x/', {
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('hands on a request its caller had already cancelled as a cancelled one', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchImpl, calls } = fakeFetch(json({ ok: true }))
    await createTransport({ fetchImpl }).get('x/', { signal: controller.signal })
    expect(calls[0]?.[1].signal?.aborted).toBe(true)
  })
})

describe('writes of every method', () => {
  it('sends PUT and PATCH with the token, a JSON body and the method named', async () => {
    const { fetchImpl, calls } = fakeFetch(session('tok-W'), json({ ok: 1 }), json({ ok: 2 }))
    const transport = createTransport({ fetchImpl })
    await transport.put('settings/notifications/me/', { enabled: true })
    await transport.patch('alert-rules/r1/', { version: 3 })
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/api/v1/console/session/', 'GET'],
      ['/api/v1/console/settings/notifications/me/', 'PUT'],
      ['/api/v1/console/alert-rules/r1/', 'PATCH'],
    ])
    expect(header(calls[1], 'X-CSRFToken')).toBe('tok-W')
    expect(header(calls[2], 'X-CSRFToken')).toBe('tok-W')
    expect(header(calls[2], 'Content-Type')).toBe('application/json')
    expect(calls[1]?.[1].body).toBe(JSON.stringify({ enabled: true }))
    expect(calls[2]?.[1].body).toBe(JSON.stringify({ version: 3 }))
  })

  it('sends a POST with no body as an empty object, never as nothing', async () => {
    const { fetchImpl, calls } = fakeFetch(session(), json({ ok: true }))
    await createTransport({ fetchImpl }).post('settings/notifications/test-email/')
    expect(calls[1]?.[1].body).toBe('{}')
  })

  it('refreshes a stale token for a PATCH too, and sends it once more', async () => {
    const { fetchImpl, calls } = fakeFetch(
      session('old'),
      failure(403, 'csrf_failed', 'CSRF check failed.'),
      session('new'),
      json({ ok: true }),
    )
    await createTransport({ fetchImpl }).patch('alert-rules/r1/', { version: 1 })
    expect(calls).toHaveLength(4)
    expect(header(calls[3], 'X-CSRFToken')).toBe('new')
    expect(calls[3]?.[1].method).toBe('PATCH')
  })
})

describe('validation errors and rate limits', () => {
  it('keeps what is wrong with each field of a validation_error, as lists of text', async () => {
    const { fetchImpl } = fakeFetch(
      session(),
      json(
        {
          error: {
            code: 'validation_error',
            message: 'Invalid request.',
            fields: {
              name: ['Taken.', 'Too long.'],
              nonField: ['Not this.'],
              bad: [1, 'ok'],
              skip: 'no',
            },
          },
        },
        400,
      ),
    )
    const error = await createTransport({ fetchImpl })
      .patch('alert-rules/r1/', { version: 1 })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_error',
      fields: { name: ['Taken.', 'Too long.'], nonField: ['Not this.'], bad: ['ok'] },
    })
  })

  it('has no fields when the answer holds none that are lists of text', async () => {
    const { fetchImpl } = fakeFetch(
      json({ error: { code: 'validation_error', message: 'Invalid.', fields: ['x'] } }, 400),
      json({ error: { code: 'validation_error', message: 'Invalid.', fields: { a: [] } } }, 400),
    )
    const transport = createTransport({ fetchImpl })
    await expect(transport.get('x/')).rejects.toMatchObject({ fields: null })
    await expect(transport.get('x/')).rejects.toMatchObject({ fields: null })
  })

  it('reads Retry-After of a 429 as whole seconds, and no other status’s', async () => {
    const limited = new Response(
      JSON.stringify({ error: { code: 'rate_limited', message: 'One a minute.' } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '42' } },
    )
    const other = new Response(
      JSON.stringify({ error: { code: 'unavailable', message: 'Busy.' } }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '42' } },
    )
    const { fetchImpl } = fakeFetch(limited, other)
    const transport = createTransport({ fetchImpl })
    await expect(transport.get('x/')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 42,
    })
    await expect(transport.get('x/')).rejects.toMatchObject({ retryAfterSeconds: null })
  })

  it.each([
    ['a date', 'Wed, 21 Oct 2026 07:28:00 GMT', null],
    ['a negative number', '-5', null],
    ['a fraction', '1.5', null],
    ['nothing', null, null],
    ['an absurd wait', '99999', 3600],
    ['zero', '0', 0],
  ])('does not believe %s as Retry-After', async (_name, value, expected) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (value !== null) headers['Retry-After'] = value
    const answer = new Response(
      JSON.stringify({ error: { code: 'rate_limited', message: 'Wait.' } }),
      {
        status: 429,
        headers,
      },
    )
    const { fetchImpl } = fakeFetch(answer)
    await expect(createTransport({ fetchImpl }).get('x/')).rejects.toMatchObject({
      retryAfterSeconds: expected,
    })
  })
})
