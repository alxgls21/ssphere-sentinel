import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from './nav'
import { SCOPE_ORDER, SCOPE_TITLE, SHORTCUTS } from './shortcuts'

describe('shortcut registry', () => {
  it('has an entry for every go-to chord in NAV_ITEMS, and nothing else bound to go', () => {
    const go = SHORTCUTS.filter((shortcut) => shortcut.action === 'go').flatMap((s) => s.keys)
    expect(go.sort()).toEqual(NAV_ITEMS.map((item) => `g ${item.chord}`).sort())
  })

  it('binds each key text to one action only', () => {
    const bound = SHORTCUTS.filter((s) => s.action).flatMap((s) => s.keys)
    expect(new Set(bound).size).toBe(bound.length)
  })

  it('never binds a key that is also the first key of a sequence', () => {
    const bound = SHORTCUTS.filter((s) => s.action).flatMap((s) => s.keys)
    const starts = new Set(bound.filter((k) => k.includes(' ')).map((k) => k.split(' ')[0]))
    expect(bound.filter((k) => starts.has(k))).toEqual([])
  })

  it('writes keys in lower case', () => {
    for (const { keys } of SHORTCUTS) for (const key of keys) expect(key).toBe(key.toLowerCase())
  })

  it('documents every scope, with distinct labels inside each', () => {
    expect(Object.keys(SCOPE_TITLE).sort()).toEqual([...SCOPE_ORDER].sort())
    for (const scope of SCOPE_ORDER) {
      const labels = SHORTCUTS.filter((s) => s.scope === scope).map((s) => s.label)
      expect(labels.length, scope).toBeGreaterThan(0)
      expect(new Set(labels).size, scope).toBe(labels.length)
    }
  })

  it('leaves the panel and palette keys to their owners (documentation only)', () => {
    for (const shortcut of SHORTCUTS.filter((s) => s.scope === 'panel' || s.scope === 'palette')) {
      expect(shortcut.action, shortcut.label).toBeUndefined()
    }
  })

  it('documents the panel keys the spec lists', () => {
    const panel = SHORTCUTS.filter((s) => s.scope === 'panel').flatMap((s) => s.keys)
    for (const key of ['j', 'k', 'enter', 'y', 'f', 'v', 'arrowleft', 'arrowright'])
      expect(panel).toContain(key)
  })
})
