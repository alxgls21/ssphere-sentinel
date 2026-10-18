import { describe, expect, it } from 'vitest'
import { CHANGE_EFFECTS, rule } from '@/features/settings/testing'
import { effectsSentence, previewChange, valuesOf } from './ruleChanges'

const open = (count: number, over = {}) => rule({ openIncidents: count, ...over })

describe('valuesOf', () => {
  it('reads the values a change can end incidents with', () => {
    expect(valuesOf(rule())).toEqual({
      enabled: true,
      health: 'critical',
      reason: 'unreachable',
      severity: 'critical',
      customerId: null,
      siteId: null,
    })
  })

  it('reads a customer scope, and a site scope as the site alone', () => {
    const customer = rule({
      scope: {
        type: 'customer',
        customerId: 'c1',
        customerName: 'M',
        siteId: null,
        siteName: null,
      },
    })
    const site = rule({
      scope: { type: 'site', customerId: 'c1', customerName: 'M', siteId: 's1', siteName: 'A' },
    })
    expect(valuesOf(customer)).toMatchObject({ customerId: 'c1', siteId: null })
    expect(valuesOf(site)).toMatchObject({ customerId: null, siteId: 's1' })
  })
})

describe('previewChange: what the API’s contract says a change ends', () => {
  it('warns that disabling a rule with open incidents ends all of them', () => {
    const before = open(3)
    const preview = previewChange(before, { ...valuesOf(before), enabled: false }, CHANGE_EFFECTS)
    expect(preview.warns).toBe(true)
    expect(preview.closesAll).toBe(true)
    expect(preview.openIncidents).toBe(3)
    expect(preview.notes.map((note) => note.closes)).toEqual(['rule_disabled'])
    expect(preview.notes[0]?.text).toMatch(
      /Disabling the rule ends its 3 open incidents, all of them/,
    )
  })

  it('does not warn when the rule has no open incident: nothing would end', () => {
    const before = open(0)
    const preview = previewChange(before, { ...valuesOf(before), enabled: false }, CHANGE_EFFECTS)
    expect(preview.warns).toBe(false)
    expect(preview.closesAll).toBe(false)
    expect(preview.notes[0]?.text).toMatch(/None is open now/)
  })

  it('does not treat switching a rule on as a closure: the contract names the value that ends', () => {
    const before = open(2, { enabled: false })
    const preview = previewChange(before, { ...valuesOf(before), enabled: true }, CHANGE_EFFECTS)
    expect(preview.notes).toEqual([])
    expect(preview.warns).toBe(false)
  })

  it.each([
    ['health', { health: 'warning' as const }],
    ['reason', { reason: null }],
    ['severity', { severity: 'warning' }],
  ])('warns that a new %s ends the incidents opened under the old one', (_name, change) => {
    const before = open(2)
    const preview = previewChange(before, { ...valuesOf(before), ...change }, CHANGE_EFFECTS)
    expect(preview.warns).toBe(true)
    expect(preview.closesAll).toBe(true)
    expect(preview.notes.map((note) => note.closes)).toEqual(['rule_changed'])
    expect(preview.notes[0]?.text).toMatch(/ends its 2 open incidents, all of them/)
  })

  it('says one note, not two, when a rule is disabled and changed at once', () => {
    const before = open(2)
    const preview = previewChange(
      before,
      { ...valuesOf(before), enabled: false, severity: 'warning' },
      CHANGE_EFFECTS,
    )
    expect(preview.notes.map((note) => note.closes)).toEqual(['rule_disabled'])
  })

  it('warns that a new scope ends the incidents outside it, in the API’s words', () => {
    const before = open(4)
    const preview = previewChange(before, { ...valuesOf(before), customerId: 'c1' }, CHANGE_EFFECTS)
    expect(preview.warns).toBe(true)
    expect(preview.closesAll).toBe(false)
    expect(preview.notes).toEqual([
      expect.objectContaining({ closes: 'out_of_scope', which: 'outside the new scope' }),
    ])
    expect(preview.notes[0]?.text).toMatch(
      /objects outside the new scope \(of its 4 open incidents\)/,
    )
  })

  it('treats a move from a customer to one of its sites as a scope change', () => {
    const before = open(1, {
      scope: {
        type: 'customer',
        customerId: 'c1',
        customerName: 'M',
        siteId: null,
        siteName: null,
      },
    })
    const preview = previewChange(
      before,
      { ...valuesOf(before), customerId: null, siteId: 's1' },
      CHANGE_EFFECTS,
    )
    expect(preview.notes.map((note) => note.closes)).toEqual(['out_of_scope'])
  })

  it('does not warn for what the contract does not name: a name, a description, the delays', () => {
    const before = open(5)
    const preview = previewChange(before, valuesOf(before), CHANGE_EFFECTS)
    expect(preview.notes).toEqual([])
    expect(preview.warns).toBe(false)
  })

  it('follows the contract it is given: no closure for a field it does not name', () => {
    const before = open(2)
    const preview = previewChange(
      before,
      { ...valuesOf(before), severity: 'warning' },
      { enabled: CHANGE_EFFECTS.enabled! },
    )
    expect(preview.notes).toEqual([])
  })

  it('says one incident in the singular', () => {
    const before = open(1)
    const preview = previewChange(before, { ...valuesOf(before), enabled: false }, CHANGE_EFFECTS)
    expect(preview.notes[0]?.text).toMatch(/its 1 open incident,/)
  })
})

describe('effectsSentence: what a saved change did', () => {
  it('says nothing changed for a change that changed nothing', () => {
    expect(effectsSentence(null)).toBe('Nothing changed: the rule is as it was.')
  })

  it('says a change that ends nothing ends no incident', () => {
    expect(effectsSentence({ openIncidents: 3, closes: [], closesAll: false })).toMatch(
      /ends no incident/,
    )
  })

  it('says what ends, and how many were open', () => {
    expect(effectsSentence({ openIncidents: 2, closes: ['rule_disabled'], closesAll: true })).toBe(
      'Saved. At the engine’s next cycle the rule’s incidents end, as it is disabled (2 open incidents when it was changed, all of them).',
    )
  })

  it('says several closures together, and one incident in the singular', () => {
    const sentence = effectsSentence({
      openIncidents: 1,
      closes: ['rule_changed', 'out_of_scope'],
      closesAll: false,
    })
    expect(sentence).toMatch(
      /condition or severity changed, and the open incidents of objects outside the new scope end/,
    )
    expect(sentence).toMatch(/1 open incident when/)
    expect(sentence).not.toMatch(/all of them/)
  })
})
