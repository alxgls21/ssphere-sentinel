import { describe, expect, it, vi } from 'vitest'
import {
  createAlertRule,
  getAlertRule,
  getAlertRuleOptions,
  listAlertRules,
  parseAlertRule,
  parseAlertRuleChange,
  parseAlertRuleDetail,
  parseAlertRuleList,
  parseAlertRuleOptions,
  parseChangeEffects,
  updateAlertRule,
} from './alertRules'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (alert_rules.py). */
const wireRule = (over: Record<string, unknown> = {}) => ({
  id: '5d2f0c1a-8f67-4d54-8d5b-0e5cb0e1f001',
  key: null,
  name: 'Device unreachable',
  description: 'Opens when a device stops answering.',
  enabled: true,
  kind: 'device',
  condition: 'health',
  health: 'critical',
  reason: 'unreachable',
  severity: 'critical',
  activationSeconds: 60,
  recoverySeconds: 120,
  scope: { type: 'all', customerId: null, customerName: null, siteId: null, siteName: null },
  openIncidents: 2,
  createdAt: '2026-09-18T10:00:00Z',
  updatedAt: '2026-10-18T09:00:00Z',
  version: 4,
  canEdit: true,
  ...over,
})
const EFFECTS = {
  enabled: { to: false, closes: 'rule_disabled', which: 'all' },
  health: { closes: 'rule_changed', which: 'all' },
  scope: { closes: 'out_of_scope', which: 'outside the new scope' },
}
const wireList = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  items: [wireRule()],
  page: { number: 1, size: 25, total: 1, pages: 1 },
  counts: { enabled: 1, disabled: 0 },
  scopeTotal: 1,
  ...over,
})
const wireDetail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  item: wireRule(),
  changeEffects: EFFECTS,
  ...over,
})
const wireOptions = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  kinds: [
    {
      value: 'device',
      label: 'SNMP device',
      conditions: [{ health: 'critical', label: 'Critical', reasons: ['unreachable'] }],
    },
  ],
  severities: [
    { value: 'critical', label: 'Critical' },
    { value: 'warning', label: 'Warning' },
  ],
  defaults: { enabled: true, activationSeconds: 60, recoverySeconds: 120 },
  limits: { maxDurationSeconds: 86400, nameMaxLength: 255, descriptionMaxLength: 2000 },
  changeEffects: EFFECTS,
  ...over,
})

const transport = (answer: unknown) => {
  const get = vi.fn(async (..._args: unknown[]) => answer)
  const post = vi.fn(async (..._args: unknown[]) => answer)
  const patch = vi.fn(async (..._args: unknown[]) => answer)
  return { get, post, patch } as unknown as Transport & {
    get: typeof get
    post: typeof post
    patch: typeof patch
  }
}

describe('an alert rule', () => {
  it('maps the answer onto the view-model, scope and version included', () => {
    expect(parseAlertRule(wireRule())).toEqual({
      id: '5d2f0c1a-8f67-4d54-8d5b-0e5cb0e1f001',
      key: null,
      name: 'Device unreachable',
      description: 'Opens when a device stops answering.',
      enabled: true,
      kind: 'device',
      health: 'critical',
      reason: 'unreachable',
      severity: 'critical',
      activationSeconds: 60,
      recoverySeconds: 120,
      scope: { type: 'all', customerId: null, customerName: null, siteId: null, siteName: null },
      openIncidents: 2,
      createdAt: '2026-09-18T10:00:00Z',
      updatedAt: '2026-10-18T09:00:00Z',
      version: 4,
      canEdit: true,
    })
  })

  it('keeps the key of a rule Sentinel installed, and a site scope with its customer', () => {
    const parsed = parseAlertRule(
      wireRule({
        key: 'device-unreachable',
        canEdit: false,
        scope: {
          type: 'site',
          customerId: 'c1',
          customerName: 'Meridian',
          siteId: 's1',
          siteName: 'Athens DC',
        },
      }),
    )
    expect(parsed.key).toBe('device-unreachable')
    expect(parsed.canEdit).toBe(false)
    expect(parsed.scope).toEqual({
      type: 'site',
      customerId: 'c1',
      customerName: 'Meridian',
      siteId: 's1',
      siteName: 'Athens DC',
    })
  })

  it('reads a rule for any reason as reason null', () => {
    expect(parseAlertRule(wireRule({ reason: null })).reason).toBeNull()
  })

  it.each([
    ['an unknown kind', { kind: 'router' }],
    ['an unknown severity', { severity: 'info' }],
    ['an unknown condition', { health: 'ok' }],
    [
      'an unknown scope type',
      {
        scope: {
          type: 'region',
          customerId: null,
          customerName: null,
          siteId: null,
          siteName: null,
        },
      },
    ],
    ['a version that is not a whole number', { version: 1.5 }],
    ['a negative delay', { activationSeconds: -1 }],
    ['a flag that is a string', { enabled: 'true' }],
    ['a missing id', { id: undefined }],
  ])('refuses a rule with %s', (_what, over) => {
    expect(() => parseAlertRule(wireRule(over))).toThrow(/unexpected answer/)
  })
})

describe('the rules list', () => {
  it('keeps the page, the counts for the chips and the total over every rule', () => {
    const list = parseAlertRuleList(
      wireList({
        page: { number: 2, size: 25, total: 31, pages: 2 },
        counts: { enabled: 20, disabled: 11 },
        scopeTotal: 40,
      }),
    )
    expect(list.page).toEqual({ number: 2, size: 25, total: 31, pages: 2 })
    expect(list.counts).toEqual({ enabled: 20, disabled: 11 })
    expect(list.scopeTotal).toBe(40)
    expect(list.items).toHaveLength(1)
  })

  it('sends only what differs from the defaults, and the rules’ own scope filter as scope', async () => {
    const t = transport(wireList())
    await listAlertRules(t)({
      q: ' meridian  core ',
      enabled: 'disabled',
      kind: 'device',
      severity: 'warning',
      scope: 'site',
      sort: 'updated',
      dir: 'desc',
      page: 2,
      pageSize: 50,
    })
    expect(t.get).toHaveBeenCalledWith('alert-rules/', {
      signal: undefined,
      query: {
        q: 'meridian  core',
        enabled: 'disabled',
        kind: 'device',
        severity: 'warning',
        scope: 'site',
        sort: 'updated',
        dir: 'desc',
        page: '2',
        pageSize: '50',
      },
    })
  })

  it('leaves out an "all" filter and an empty search', async () => {
    const t = transport(wireList())
    await listAlertRules(t)({ enabled: 'all', kind: 'all', severity: 'all', scope: 'all', q: '  ' })
    const call = t.get.mock.calls[0] as unknown as [string, { query: Record<string, unknown> }]
    for (const name of ['enabled', 'kind', 'severity', 'scope', 'q', 'page', 'sort']) {
      expect(call[1].query[name], name).toBeUndefined()
    }
  })

  it('asks with no options at all', async () => {
    const t = transport(wireList())
    await listAlertRules(t)()
    expect(t.get).toHaveBeenCalledWith('alert-rules/', {
      signal: undefined,
      query: expect.any(Object),
    })
  })
})

describe('one rule and its change effects', () => {
  it('maps the detail with the API’s changeEffects contract, field by field', () => {
    const detail = parseAlertRuleDetail(wireDetail())
    expect(detail.changeEffects).toEqual({
      enabled: { to: false, closes: 'rule_disabled', which: 'all' },
      health: { closes: 'rule_changed', which: 'all' },
      scope: { closes: 'out_of_scope', which: 'outside the new scope' },
    })
    expect(detail.changeEffects.health).not.toHaveProperty('to')
  })

  it('refuses a closure it does not know, rather than warn about the wrong thing', () => {
    expect(() =>
      parseChangeEffects({ enabled: { to: false, closes: 'rule_deleted', which: 'all' } }),
    ).toThrow(/unexpected answer/)
  })

  it('reads one rule by its id, encoded as a path segment', async () => {
    const t = transport(wireDetail())
    await getAlertRule(t)('a/b c')
    expect(t.get).toHaveBeenCalledWith('alert-rules/a%2Fb%20c/', { signal: undefined })
  })
})

describe('the options', () => {
  it('maps the kinds with their conditions and reasons, the severities, the defaults and the limits', () => {
    const options = parseAlertRuleOptions(wireOptions())
    expect(options.kinds).toEqual([
      {
        value: 'device',
        label: 'SNMP device',
        conditions: [{ health: 'critical', label: 'Critical', reasons: ['unreachable'] }],
      },
    ])
    expect(options.severities.map((entry) => entry.value)).toEqual(['critical', 'warning'])
    expect(options.defaults).toEqual({ enabled: true, activationSeconds: 60, recoverySeconds: 120 })
    expect(options.limits).toEqual({
      maxDurationSeconds: 86400,
      nameMaxLength: 255,
      descriptionMaxLength: 2000,
    })
    expect(Object.keys(options.changeEffects)).toEqual(['enabled', 'health', 'scope'])
  })

  it.each([
    [
      'a limit of zero',
      { limits: { maxDurationSeconds: 0, nameMaxLength: 255, descriptionMaxLength: 2000 } },
    ],
    ['a kind it does not know', { kinds: [{ value: 'router', label: 'Router', conditions: [] }] }],
    [
      'a reason that is not text',
      {
        kinds: [
          {
            value: 'device',
            label: 'D',
            conditions: [{ health: 'critical', label: 'C', reasons: [1] }],
          },
        ],
      },
    ],
  ])('refuses options with %s', (_what, over) => {
    expect(() => parseAlertRuleOptions(wireOptions(over))).toThrow(/unexpected answer/)
  })

  it('asks for the options of a form', async () => {
    const t = transport(wireOptions())
    await getAlertRuleOptions(t)()
    expect(t.get).toHaveBeenCalledWith('alert-rules/options/', { signal: undefined })
  })
})

describe('creating a rule', () => {
  it('posts the fields it was given, named one by one, and nothing else', async () => {
    const t = transport(wireDetail())
    const input = {
      name: 'Core down',
      kind: 'device',
      health: 'critical',
      severity: 'critical',
      reason: null,
      customerId: 'c1',
      siteId: null,
      key: 'device-unreachable',
      id: 'forged',
      version: 99,
      canEdit: true,
    } as unknown as Parameters<ReturnType<typeof createAlertRule>>[0]
    await createAlertRule(t)(input)
    expect(t.post).toHaveBeenCalledWith(
      'alert-rules/',
      {
        name: 'Core down',
        kind: 'device',
        health: 'critical',
        severity: 'critical',
        reason: null,
        customerId: 'c1',
        siteId: null,
      },
      { signal: undefined },
    )
  })

  it('leaves out what it was not given, so the server’s defaults apply', async () => {
    const t = transport(wireDetail())
    await createAlertRule(t)({ name: 'N', kind: 'server', health: 'warning', severity: 'warning' })
    const body = t.post.mock.calls[0]?.[1] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['health', 'kind', 'name', 'severity'])
  })

  it('answers with the rule as created and the contract', async () => {
    const t = transport(
      wireDetail({ item: wireRule({ id: 'new-1', version: 1, openIncidents: 0 }) }),
    )
    const created = await createAlertRule(t)({
      name: 'N',
      kind: 'device',
      health: 'critical',
      severity: 'critical',
    })
    expect(created.item).toMatchObject({ id: 'new-1', version: 1 })
    expect(created.changeEffects.enabled?.closes).toBe('rule_disabled')
  })
})

describe('changing a rule', () => {
  const change = (over: Record<string, unknown> = {}) => ({
    generatedAt: '2026-10-18T10:00:00Z',
    item: wireRule({ version: 5 }),
    effects: { openIncidents: 2, closes: ['rule_disabled'], closesAll: true },
    ...over,
  })

  it('patches the changed fields with the version that was read', async () => {
    const t = transport(change())
    await updateAlertRule(t)('r1', { enabled: false, version: 4 })
    expect(t.patch).toHaveBeenCalledWith(
      'alert-rules/r1/',
      { enabled: false, version: 4 },
      { signal: undefined },
    )
  })

  it('never sends a kind, even when one is passed: a rule’s kind does not change', async () => {
    const t = transport(change())
    const patch = { name: 'Renamed', kind: 'server', version: 4 } as unknown as Parameters<
      ReturnType<typeof updateAlertRule>
    >[1]
    await updateAlertRule(t)('r1', patch)
    const body = t.patch.mock.calls[0]?.[1] as Record<string, unknown>
    expect(body).toEqual({ name: 'Renamed', version: 4 })
    expect(body).not.toHaveProperty('kind')
  })

  it('sends null only for what means none: any reason, no customer', async () => {
    const t = transport(change())
    await updateAlertRule(t)('r1', { reason: null, customerId: null, siteId: null, version: 2 })
    expect(t.patch.mock.calls[0]?.[1]).toEqual({
      reason: null,
      customerId: null,
      siteId: null,
      version: 2,
    })
  })

  it('encodes the id as a path segment', async () => {
    const t = transport(change())
    await updateAlertRule(t)('a/b', { version: 1 })
    expect(t.patch.mock.calls[0]?.[0]).toBe('alert-rules/a%2Fb/')
  })

  it('reads what the change does to open incidents', () => {
    expect(parseAlertRuleChange(change()).effects).toEqual({
      openIncidents: 2,
      closes: ['rule_disabled'],
      closesAll: true,
    })
  })

  it('reads a change that changed nothing as effects null, the version unchanged', () => {
    const unchanged = parseAlertRuleChange(
      change({ item: wireRule({ version: 4 }), effects: null }),
    )
    expect(unchanged.effects).toBeNull()
    expect(unchanged.item.version).toBe(4)
  })

  it('refuses effects that are not the contract', () => {
    expect(() =>
      parseAlertRuleChange(
        change({ effects: { openIncidents: 1, closes: ['gone'], closesAll: false } }),
      ),
    ).toThrow(/unexpected answer/)
  })
})
