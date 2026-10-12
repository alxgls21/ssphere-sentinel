import { describe, expect, it } from 'vitest'
import { chipOf, parseQuery, stepChip, stripPrefix } from './query'

describe('parseQuery', () => {
  it('uses the chip when there is no prefix', () => {
    expect(parseQuery('edge', 'goto')).toEqual({ scope: 'goto', text: 'edge' })
    expect(parseQuery('', 'all')).toEqual({ scope: 'all', text: '' })
  })

  it.each([
    ['>', 'actions'],
    ['@', 'entities'],
    ['#', 'sites'],
    ['?', 'help'],
  ] as const)('reads %s as the %s scope', (prefix, scope) => {
    expect(parseQuery(`${prefix}pause`, 'all')).toEqual({ scope, text: 'pause' })
  })

  it('lets the prefix win over the chip', () => {
    expect(parseQuery('>pause', 'entities').scope).toBe('actions')
  })

  it('ignores whitespace around the prefix and the text', () => {
    expect(parseQuery('  > pause now ', 'all')).toEqual({ scope: 'actions', text: 'pause now' })
  })

  it('only reads a prefix at the start', () => {
    expect(parseQuery('a>b', 'all')).toEqual({ scope: 'all', text: 'a>b' })
  })
})

describe('stripPrefix', () => {
  it('removes a leading prefix and nothing else', () => {
    expect(stripPrefix('>pause')).toBe('pause')
    expect(stripPrefix('@')).toBe('')
    expect(stripPrefix('pause')).toBe('pause')
    expect(stripPrefix('a@b')).toBe('a@b')
  })
})

describe('chipOf', () => {
  it('shows sites under Entities and gives help no chip', () => {
    expect(chipOf('sites')).toBe('entities')
    expect(chipOf('help')).toBeNull()
    expect(chipOf('goto')).toBe('goto')
  })
})

describe('stepChip', () => {
  it('cycles forward and back, wrapping', () => {
    expect(stepChip('all', 1)).toBe('goto')
    expect(stepChip('actions', 1)).toBe('all')
    expect(stepChip('all', -1)).toBe('actions')
    expect(stepChip('entities', -1)).toBe('goto')
  })

  it('goes to All from a scope that has no chip', () => {
    expect(stepChip(null, 1)).toBe('all')
    expect(stepChip(null, -1)).toBe('all')
  })
})
