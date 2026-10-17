import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import {
  acknowledgeIncident,
  getEngineStatus,
  getIncident,
  listIncidents,
  parseEngineStatus,
  parseIncidentDetail,
  parseIncidentList,
} from './incidents'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (incidents.py). */
const incident = (over: Record<string, unknown> = {}) => ({
  id: '6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11',
  status: 'active',
  severity: 'critical',
  condition: { health: 'critical', reason: 'unreachable' },
  entity: { kind: 'device', ref: 'd1', label: 'ath-core-sw' },
  rule: { id: 'r1', name: 'Device unreachable' },
  siteId: 'site-1',
  customerName: 'Meridian',
  siteName: 'Athens DC',
  startedAt: '2026-10-18T09:48:00Z',
  openedAt: '2026-10-18T09:50:00Z',
  acknowledgedAt: null,
  acknowledgedBy: null,
  recoveredAt: null,
  closedAt: null,
  closeReason: null,
  canAcknowledge: true,
  ...over,
})
const list = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  items: [incident()],
  page: { number: 1, size: 50, total: 1, pages: 1 },
  counts: { active: 1, acknowledged: 0, recovered: 2, closed: 1 },
  scopeTotal: 4,
  ...over,
})
const detail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  item: incident(),
  rule: {
    id: 'r1',
    name: 'Device unreachable',
    description: 'Opens when a device stops answering.',
    enabled: true,
  },
  entityVisible: true,
  timeline: [
    {
      at: '2026-10-18T09:50:00Z',
      kind: 'opened',
      health: 'critical',
      reason: 'unreachable',
      actor: null,
    },
  ],
  ...over,
})
const engine = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  state: 'running',
  stale: false,
  staleAfterSeconds: 180,
  intervalSeconds: 60,
  startedAt: '2026-10-17T10:00:00Z',
  lastSuccessAt: '2026-10-18T09:59:48Z',
  lastAttemptAt: '2026-10-18T09:59:48Z',
  lastCycleMs: 140,
  lastError: null,
  monitoringSince: '2026-10-17T10:05:00Z',
  ...over,
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  const post = vi.fn(async () => answer)
  return { get, post } as unknown as Transport & { get: typeof get; post: typeof post }
}

describe('incident list', () => {
  it('maps the answer onto the view-model, keeping the page, the counts and the scope total', async () => {
    const result = await listIncidents(transport(list()))()
    expect(result.items[0]).toEqual({
      id: '6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11',
      status: 'active',
      severity: 'critical',
      condition: { health: 'critical', reason: 'unreachable' },
      entity: { kind: 'device', ref: 'd1', label: 'ath-core-sw' },
      rule: { id: 'r1', name: 'Device unreachable' },
      siteId: 'site-1',
      customerName: 'Meridian',
      siteName: 'Athens DC',
      startedAt: '2026-10-18T09:48:00Z',
      openedAt: '2026-10-18T09:50:00Z',
      acknowledgedAt: null,
      acknowledgedBy: null,
      recoveredAt: null,
      closedAt: null,
      closeReason: null,
      canAcknowledge: true,
    })
    expect(result.page).toEqual({ number: 1, size: 50, total: 1, pages: 1 })
    expect(result.counts).toEqual({ active: 1, acknowledged: 0, recovered: 2, closed: 1 })
    expect(result.scopeTotal).toBe(4)
  })

  it('sends only what differs from the defaults: scope, search, status, severity, kind, sort, page', async () => {
    const t = transport(list())
    await listIncidents(t)({
      scope: { customerId: 'c1', siteId: 's1' },
      q: ' core  sw ',
      status: 'open',
      severity: 'critical',
      kind: 'device',
      sort: 'severity',
      dir: 'desc',
      page: 3,
      pageSize: 25,
    })
    expect(t.get).toHaveBeenCalledWith('incidents/', {
      signal: undefined,
      query: {
        customer: 'c1',
        site: 's1',
        q: 'core  sw',
        status: 'open',
        severity: 'critical',
        kind: 'device',
        sort: 'severity',
        dir: 'desc',
        page: '3',
        pageSize: '25',
      },
    })
  })

  it('leaves out an "all" filter, an empty search and an unset scope', async () => {
    const t = transport(list())
    await listIncidents(t)({ status: 'all', severity: 'all', kind: 'all', q: '  ' })
    const call = t.get.mock.calls[0] as unknown as [
      string,
      { query: Record<string, string | undefined> },
    ]
    const query = call[1].query
    for (const name of ['status', 'severity', 'kind', 'q', 'customer', 'site']) {
      expect(query[name], name).toBeUndefined()
    }
  })

  it('keeps an incident of an object on no site: no site or customer name, no site id', () => {
    const { customerName, siteName, ...bare } = incident({ siteId: null })
    void customerName
    void siteName
    const [only] = parseIncidentList(list({ items: [bare] })).items
    expect(only?.siteId).toBeNull()
    expect(only).not.toHaveProperty('siteName')
    expect(only).not.toHaveProperty('customerName')
  })

  it('keeps every status, severity and kind the API names, and the acknowledgement and closure', () => {
    const items = [
      incident({
        status: 'acknowledged',
        acknowledgedAt: '2026-10-18T09:55:00Z',
        acknowledgedBy: 'maria',
        canAcknowledge: false,
      }),
      incident({
        status: 'recovered',
        severity: 'warning',
        recoveredAt: '2026-10-18T09:58:00Z',
        closedAt: '2026-10-18T09:59:00Z',
        canAcknowledge: false,
        entity: { kind: 'interface', ref: 'd1:12', label: 'Gi1/0/12' },
      }),
      incident({
        status: 'closed',
        closedAt: '2026-10-18T09:59:00Z',
        closeReason: 'entity_removed',
        canAcknowledge: false,
        entity: { kind: 'container', ref: 's1:abc', label: 'nginx' },
      }),
    ]
    const result = parseIncidentList(list({ items })).items
    expect(result.map((entry) => entry.status)).toEqual(['acknowledged', 'recovered', 'closed'])
    expect(result[0]).toMatchObject({ acknowledgedBy: 'maria', canAcknowledge: false })
    expect(result[1]).toMatchObject({ severity: 'warning', entity: { kind: 'interface' } })
    expect(result[2]).toMatchObject({
      closeReason: 'entity_removed',
      entity: { kind: 'container' },
    })
  })

  it('reads the reason as null when there is none, and shows one it does not know as it came', () => {
    const [none, odd] = parseIncidentList(
      list({
        items: [
          incident({ condition: { health: 'warning', reason: null } }),
          incident({ condition: { health: 'unknown', reason: 'a_new_reason' } }),
        ],
      }),
    ).items
    expect(none?.condition).toEqual({ health: 'warning', reason: null })
    expect(odd?.condition.reason).toBe('a_new_reason')
  })

  it('refuses an answer that does not fit: a status, severity, kind or time it does not know, a missing count', () => {
    const bad = (over: Record<string, unknown>) => () => parseIncidentList(list(over))
    for (const change of [
      { status: 'resolved' },
      { severity: 'major' },
      { entity: { kind: 'site', ref: 'x', label: 'y' } },
      { openedAt: 'yesterday' },
      { closeReason: 'because' },
      { canAcknowledge: 'yes' },
    ]) {
      expect(bad({ items: [incident(change)] })).toThrowError(
        expect.objectContaining({ code: 'bad_response' }),
      )
    }
    expect(bad({ counts: { active: 1, acknowledged: 0, recovered: 0 } })).toThrowError(
      expect.objectContaining({ code: 'bad_response' }),
    )
    expect(bad({ scopeTotal: -1 })).toThrowError(expect.objectContaining({ code: 'bad_response' }))
    expect(bad({ items: 'none' })).toThrowError(expect.objectContaining({ code: 'bad_response' }))
  })

  it('drops every field it does not name, so nothing else an answer holds reaches a screen', () => {
    const [only] = parseIncidentList(
      list({
        items: [
          incident({
            secret: 'x',
            actorEmail: 'a@b.c',
            entity: { kind: 'device', ref: 'd1', label: 'x', token: 't' },
          }),
        ],
      }),
    ).items
    expect(JSON.stringify(only)).not.toMatch(/secret|actorEmail|token/)
  })
})

describe('incident detail', () => {
  it('maps the item, the rule, the visibility and the timeline in order', async () => {
    const t = transport(
      detail({
        timeline: [
          {
            at: '2026-10-18T09:50:00Z',
            kind: 'opened',
            health: 'critical',
            reason: 'unreachable',
            actor: null,
          },
          {
            at: '2026-10-18T09:55:00Z',
            kind: 'acknowledged',
            health: null,
            reason: null,
            actor: 'maria',
          },
          {
            at: '2026-10-18T09:58:00Z',
            kind: 'recovery_started',
            health: 'healthy',
            reason: 'ok',
            actor: null,
          },
          {
            at: '2026-10-18T09:58:30Z',
            kind: 'recovery_interrupted',
            health: 'critical',
            reason: 'unreachable',
            actor: null,
          },
          {
            at: '2026-10-18T09:59:00Z',
            kind: 'recovered',
            health: 'healthy',
            reason: 'ok',
            actor: null,
          },
          { at: '2026-10-18T09:59:30Z', kind: 'closed', health: null, reason: null, actor: null },
        ],
      }),
    )
    const result = await getIncident(t)('6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11')
    expect(t.get).toHaveBeenCalledWith('incidents/6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11/', {
      signal: undefined,
    })
    expect(result.rule).toEqual({
      id: 'r1',
      name: 'Device unreachable',
      description: 'Opens when a device stops answering.',
      enabled: true,
    })
    expect(result.entityVisible).toBe(true)
    expect(result.timeline.map((step) => step.kind)).toEqual([
      'opened',
      'acknowledged',
      'recovery_started',
      'recovery_interrupted',
      'recovered',
      'closed',
    ])
    expect(result.timeline[1]).toMatchObject({ actor: 'maria', health: null, reason: null })
    expect(result.timeline[0]).toMatchObject({ health: 'critical', reason: 'unreachable' })
  })

  it('keeps an object the user may not see as not visible, and an empty description as an empty string', () => {
    const result = parseIncidentDetail(
      detail({
        entityVisible: false,
        rule: { id: 'r1', name: 'n', description: '', enabled: false },
      }),
    )
    expect(result.entityVisible).toBe(false)
    expect(result.rule).toMatchObject({ description: '', enabled: false })
  })

  it('accepts a timeline with no step, and refuses one with a step kind it does not know', () => {
    expect(parseIncidentDetail(detail({ timeline: [] })).timeline).toEqual([])
    expect(() =>
      parseIncidentDetail(
        detail({
          timeline: [
            {
              at: '2026-10-18T09:50:00Z',
              kind: 'resolved',
              health: null,
              reason: null,
              actor: null,
            },
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'bad_response' }))
  })

  it('encodes the id as one path segment', async () => {
    const t = transport(detail())
    await getIncident(t)('a/b c')
    expect(t.get).toHaveBeenCalledWith('incidents/a%2Fb%20c/', { signal: undefined })
  })

  it('lets a 404 through for the page to say not found', async () => {
    const t = {
      get: vi.fn().mockRejectedValue(new ApiError('Not found.', 404, 'not_found')),
      post: vi.fn(),
    } as unknown as Transport
    await expect(getIncident(t)('x')).rejects.toMatchObject({ status: 404 })
  })
})

describe('acknowledge', () => {
  it('posts to the incident’s acknowledge path with no body, and maps the detail it answers', async () => {
    const t = transport(
      detail({
        item: incident({
          status: 'acknowledged',
          acknowledgedAt: '2026-10-18T10:00:00Z',
          acknowledgedBy: 'maria',
          canAcknowledge: false,
        }),
      }),
    )
    const controller = new AbortController()
    const result = await acknowledgeIncident(t)('inc 1', { signal: controller.signal })
    expect(t.post).toHaveBeenCalledWith('incidents/inc%201/acknowledge/', undefined, {
      signal: controller.signal,
    })
    expect(t.get).not.toHaveBeenCalled()
    expect(result.item).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'maria' })
  })

  it('lets every refusal through with its status and code: 403, 404, 409 and a network failure', async () => {
    const fail = (error: ApiError) =>
      acknowledgeIncident({
        get: vi.fn(),
        post: vi.fn().mockRejectedValue(error),
      } as unknown as Transport)('x')
    await expect(fail(new ApiError('no', 403, 'forbidden'))).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
    await expect(fail(new ApiError('gone', 404, 'not_found'))).rejects.toMatchObject({
      status: 404,
    })
    await expect(fail(new ApiError('ended', 409, 'incident_ended'))).rejects.toMatchObject({
      status: 409,
      code: 'incident_ended',
    })
    await expect(
      fail(new ApiError('Cannot reach the server.', null, 'network')),
    ).rejects.toMatchObject({
      code: 'network',
    })
  })

  it('refuses a malformed answer rather than showing an acknowledgement it cannot read', async () => {
    const t = transport({ ok: true })
    await expect(acknowledgeIncident(t)('x')).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('engine status', () => {
  it('maps a running engine', async () => {
    const t = transport(engine())
    const result = await getEngineStatus(t)()
    expect(t.get).toHaveBeenCalledWith('alerts/engine-status/', { signal: undefined })
    expect(result).toEqual({
      generatedAt: '2026-10-18T10:00:00Z',
      state: 'running',
      stale: false,
      staleAfterSeconds: 180,
      intervalSeconds: 60,
      startedAt: '2026-10-17T10:00:00Z',
      lastSuccessAt: '2026-10-18T09:59:48Z',
      lastAttemptAt: '2026-10-18T09:59:48Z',
      lastCycleMs: 140,
      lastError: null,
      monitoringSince: '2026-10-17T10:05:00Z',
    })
  })

  it('keeps each of the four states as the API said it', () => {
    for (const state of ['running', 'failed', 'stale', 'never_started'] as const) {
      expect(parseEngineStatus(engine({ state })).state).toBe(state)
    }
  })

  it('keeps an engine that never started as nothing: every time and the interval null', () => {
    const result = parseEngineStatus(
      engine({
        state: 'never_started',
        stale: true,
        intervalSeconds: null,
        startedAt: null,
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastCycleMs: null,
        monitoringSince: null,
      }),
    )
    expect(result).toMatchObject({
      state: 'never_started',
      intervalSeconds: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      monitoringSince: null,
    })
  })

  it('keeps a failure’s category and time, and nothing of its message', () => {
    const result = parseEngineStatus(
      engine({
        state: 'failed',
        lastError: {
          at: '2026-10-18T09:59:50Z',
          category: 'database',
          message: 'password=hunter2',
        },
      }),
    )
    expect(result.lastError).toEqual({ at: '2026-10-18T09:59:50Z', category: 'database' })
    expect(JSON.stringify(result)).not.toMatch(/hunter2/)
  })

  it('refuses a state or an error category it does not know', () => {
    expect(() => parseEngineStatus(engine({ state: 'healthy' }))).toThrowError(
      expect.objectContaining({ code: 'bad_response' }),
    )
    expect(() =>
      parseEngineStatus(engine({ lastError: { at: '2026-10-18T09:59:50Z', category: 'network' } })),
    ).toThrowError(expect.objectContaining({ code: 'bad_response' }))
    expect(() => parseEngineStatus(engine({ staleAfterSeconds: 'soon' }))).toThrowError(
      expect.objectContaining({ code: 'bad_response' }),
    )
  })
})
