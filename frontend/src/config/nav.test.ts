import { describe, expect, it } from 'vitest'
import { FEATURES } from './features'
import { NAV_ITEMS, navItemForPath } from './nav'

describe('navigation registry', () => {
  it('has unique ids, paths and go-to chords', () => {
    for (const key of ['id', 'path', 'chord'] as const) {
      const values = NAV_ITEMS.map((item) => item[key])
      expect(new Set(values).size).toBe(values.length)
    }
  })

  it('uses single-letter chords and absolute paths', () => {
    for (const item of NAV_ITEMS) {
      expect(item.chord).toMatch(/^[a-z]$/)
      expect(item.path.startsWith('/')).toBe(true)
    }
  })

  it('references only known backend features', () => {
    for (const item of NAV_ITEMS) if (item.feature) expect(FEATURES[item.feature]).toBeDefined()
  })

  it('lists the Overview first, then the designed screens in order of approval', () => {
    expect(NAV_ITEMS[0]?.id).toBe('overview')
    expect(NAV_ITEMS.filter((item) => item.designed).map((item) => item.id)).toEqual([
      'overview',
      'servers',
    ])
  })

  it('resolves a pathname to its screen', () => {
    expect(navItemForPath('/')?.id).toBe('overview')
    expect(navItemForPath('/servers')?.id).toBe('servers')
    expect(navItemForPath('/servers/srv-1')?.id).toBe('servers')
    expect(navItemForPath('/nope')).toBeUndefined()
  })
})
