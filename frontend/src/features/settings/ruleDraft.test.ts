import { describe, expect, it } from 'vitest'
import { options, rule } from './testing'
import {
  conditionsOf,
  draftFromRule,
  effectValues,
  hasErrors,
  newDraft,
  reasonsOf,
  toInput,
  toPatch,
  validate,
  withHealth,
  withKind,
  withScopeType,
} from './ruleDraft'

const OPTIONS = options()

describe('what a form may offer comes from the options', () => {
  it('lists the conditions of a kind, and the reasons of a condition', () => {
    expect(conditionsOf(OPTIONS, 'server').map((entry) => entry.health)).toEqual([
      'critical',
      'warning',
    ])
    expect(reasonsOf(OPTIONS, 'server', 'critical')).toEqual(['offline', 'resources'])
    expect(reasonsOf(OPTIONS, 'device', 'unknown')).toEqual([])
  })

  it('offers nothing for a kind, or a condition, the options do not list', () => {
    expect(conditionsOf(OPTIONS, 'container')).toEqual([])
    expect(reasonsOf(OPTIONS, 'server', 'unknown')).toEqual([])
  })

  it('starts a new rule from the first kind, its first condition, the first severity and the defaults', () => {
    expect(newDraft(OPTIONS)).toEqual({
      name: '',
      description: '',
      enabled: true,
      kind: 'server',
      health: 'critical',
      reason: '',
      severity: 'critical',
      activationSeconds: '60',
      recoverySeconds: '120',
      scopeType: 'all',
      customerId: '',
      siteId: '',
    })
  })

  it('takes the defaults the API lists, not its own', () => {
    const draft = newDraft(
      options({ defaults: { enabled: false, activationSeconds: 5, recoverySeconds: 9 } }),
    )
    expect(draft).toMatchObject({ enabled: false, activationSeconds: '5', recoverySeconds: '9' })
  })

  it('starts a condition over for a new kind: what can fire is the kind’s own', () => {
    const draft = { ...newDraft(OPTIONS), health: 'warning' as const, reason: 'resources' }
    expect(withKind(draft, OPTIONS, 'device')).toMatchObject({
      kind: 'device',
      health: 'critical',
      reason: '',
    })
  })

  it('keeps a reason for a new condition only when that condition can fire it', () => {
    const draft = { ...newDraft(OPTIONS), reason: 'resources' }
    expect(withHealth(draft, OPTIONS, 'warning').reason).toBe('resources')
    expect(withHealth({ ...draft, reason: 'offline' }, OPTIONS, 'warning').reason).toBe('')
  })

  it('clears the customer and the site when the scope becomes all, and keeps them otherwise', () => {
    const draft = {
      ...newDraft(OPTIONS),
      scopeType: 'site' as const,
      customerId: 'c1',
      siteId: 's1',
    }
    expect(withScopeType(draft, 'all')).toMatchObject({ customerId: '', siteId: '' })
    expect(withScopeType(draft, 'customer')).toMatchObject({ customerId: 'c1', siteId: 's1' })
  })
})

describe('a draft from a rule', () => {
  it('holds the rule’s values as the form edits them: text for the delays, "" for any reason', () => {
    expect(draftFromRule(rule({ reason: null }))).toEqual({
      name: 'Device unreachable',
      description: 'Opens when a device stops answering.',
      enabled: true,
      kind: 'device',
      health: 'critical',
      reason: '',
      severity: 'critical',
      activationSeconds: '60',
      recoverySeconds: '120',
      scopeType: 'all',
      customerId: '',
      siteId: '',
    })
  })

  it('keeps a site’s customer, to narrow the sites it offers', () => {
    const draft = draftFromRule(
      rule({
        scope: { type: 'site', customerId: 'c1', customerName: 'M', siteId: 's1', siteName: 'A' },
      }),
    )
    expect(draft).toMatchObject({ scopeType: 'site', customerId: 'c1', siteId: 's1' })
  })
})

describe('what is checked before anything is sent', () => {
  const valid = { ...newDraft(OPTIONS), name: 'Core down' }

  it('finds nothing wrong with a complete draft', () => {
    expect(validate(valid, OPTIONS)).toEqual({})
    expect(hasErrors({})).toBe(false)
  })

  it('wants a name, and not a longer one than the API takes', () => {
    expect(validate({ ...valid, name: '   ' }, OPTIONS).name).toEqual(['Give the rule a name.'])
    expect(validate({ ...valid, name: 'x'.repeat(81) }, OPTIONS).name).toEqual([
      'At most 80 characters.',
    ])
    expect(validate({ ...valid, name: 'x'.repeat(80) }, OPTIONS).name).toBeUndefined()
  })

  it('does not take a longer description than the API takes', () => {
    expect(validate({ ...valid, description: 'x'.repeat(201) }, OPTIONS).description).toEqual([
      'At most 200 characters.',
    ])
  })

  it('wants a condition the kind can have, and a reason the condition can fire', () => {
    expect(validate({ ...valid, kind: 'device', health: 'warning' }, OPTIONS).health).toBeDefined()
    expect(validate({ ...valid, reason: 'cpu_spike' }, OPTIONS).reason).toEqual([
      'Choose one of the reasons offered, or any reason.',
    ])
    expect(validate({ ...valid, reason: 'offline' }, OPTIONS).reason).toBeUndefined()
  })

  it.each([
    ['empty', ''],
    ['text', 'soon'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['over the limit', '86401'],
  ])('refuses a delay that is %s, saying the range the API gives', (_name, value) => {
    const errors = validate({ ...valid, activationSeconds: value, recoverySeconds: value }, OPTIONS)
    expect(errors.activationSeconds).toEqual(['Enter a whole number of seconds from 0 to 86400.'])
    expect(errors.recoverySeconds).toEqual(['Enter a whole number of seconds from 0 to 86400.'])
  })

  it('accepts a delay of zero and one at the limit', () => {
    expect(
      validate({ ...valid, activationSeconds: '0', recoverySeconds: '86400' }, OPTIONS),
    ).toEqual({})
  })

  it('wants a customer for a customer scope and a site for a site scope', () => {
    expect(validate({ ...valid, scopeType: 'customer' }, OPTIONS).customerId).toEqual([
      'Choose a customer.',
    ])
    expect(validate({ ...valid, scopeType: 'site' }, OPTIONS).siteId).toEqual(['Choose a site.'])
    expect(validate({ ...valid, scopeType: 'site', siteId: 's1' }, OPTIONS)).toEqual({})
  })

  it('says every error it finds, not the first', () => {
    const errors = validate({ ...valid, name: '', activationSeconds: 'x' }, OPTIONS)
    expect(Object.keys(errors).sort()).toEqual(['activationSeconds', 'name'])
    expect(hasErrors(errors)).toBe(true)
  })
})

describe('a new rule’s body', () => {
  it('sends the draft as the API takes it: trimmed name, numbers, null for any reason', () => {
    expect(toInput({ ...newDraft(OPTIONS), name: '  Core down ' }, OPTIONS)).toEqual({
      name: 'Core down',
      description: '',
      enabled: true,
      kind: 'server',
      health: 'critical',
      reason: null,
      severity: 'critical',
      activationSeconds: 60,
      recoverySeconds: 120,
      customerId: null,
      siteId: null,
    })
  })

  it('sends at most one of customer and site, whichever the scope names', () => {
    const base = { ...newDraft(OPTIONS), name: 'N', customerId: 'c1', siteId: 's1' }
    expect(toInput({ ...base, scopeType: 'customer' }, OPTIONS)).toMatchObject({
      customerId: 'c1',
      siteId: null,
    })
    expect(toInput({ ...base, scopeType: 'site' }, OPTIONS)).toMatchObject({
      customerId: null,
      siteId: 's1',
    })
    expect(toInput({ ...base, scopeType: 'all' }, OPTIONS)).toMatchObject({
      customerId: null,
      siteId: null,
    })
  })
})

describe('a change’s body', () => {
  const current = rule({ version: 7 })

  it('is nothing when nothing changed', () => {
    expect(toPatch(draftFromRule(current), current, OPTIONS)).toBeNull()
  })

  it('holds only what changed, and the version that was read', () => {
    const draft = { ...draftFromRule(current), name: ' Renamed ', severity: 'warning' as const }
    expect(toPatch(draft, current, OPTIONS)).toEqual({
      name: 'Renamed',
      severity: 'warning',
      version: 7,
    })
  })

  it('never holds the kind, whatever the draft says', () => {
    const draft = { ...draftFromRule(current), kind: 'server' as const, name: 'Renamed' }
    expect(toPatch(draft, current, OPTIONS)).not.toHaveProperty('kind')
  })

  it('says any reason as null', () => {
    const draft = { ...draftFromRule(current), reason: '' }
    expect(toPatch(draft, current, OPTIONS)).toEqual({ reason: null, version: 7 })
  })

  it('holds a delay only when its number differs', () => {
    const draft = { ...draftFromRule(current), activationSeconds: '60', recoverySeconds: '300' }
    expect(toPatch(draft, current, OPTIONS)).toEqual({ recoverySeconds: 300, version: 7 })
  })

  it('holds the whole scope, both ids, when either differs', () => {
    const draft = { ...draftFromRule(current), scopeType: 'customer' as const, customerId: 'c1' }
    expect(toPatch(draft, current, OPTIONS)).toEqual({
      customerId: 'c1',
      siteId: null,
      version: 7,
    })
  })

  it('holds a switch from one site to a customer as the customer alone', () => {
    const site = rule({
      version: 2,
      scope: { type: 'site', customerId: 'c1', customerName: 'M', siteId: 's1', siteName: 'A' },
    })
    const draft = { ...draftFromRule(site), scopeType: 'customer' as const, siteId: '' }
    expect(toPatch(draft, site, OPTIONS)).toEqual({ customerId: 'c1', siteId: null, version: 2 })
  })

  it('leaves out the scope while it is as it was, even for a site scope with its customer', () => {
    const site = rule({
      scope: { type: 'site', customerId: 'c1', customerName: 'M', siteId: 's1', siteName: 'A' },
    })
    expect(toPatch({ ...draftFromRule(site), name: 'X' }, site, OPTIONS)).toEqual({
      name: 'X',
      version: site.version,
    })
  })
})

describe('the values a change is judged by', () => {
  it('are the draft’s, with any reason as null and the scope as the two ids', () => {
    const draft = {
      ...newDraft(OPTIONS),
      enabled: false,
      scopeType: 'site' as const,
      customerId: 'c1',
      siteId: 's1',
    }
    expect(effectValues(draft)).toEqual({
      enabled: false,
      health: 'critical',
      reason: null,
      severity: 'critical',
      customerId: null,
      siteId: 's1',
    })
  })
})
