/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOKEN_GROUPS, resolvePalette } from './tokens'

const css = readFileSync(join(import.meta.dirname, '../../styles/tokens.css'), 'utf8')

/** The first declaration of each color token: the @theme block, not the prefers-contrast override. */
const declared = new Map<string, string>()
for (const match of css.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)) {
  const [, name, value] = match
  if (name && value && !declared.has(name)) declared.set(name, value.trim())
}

const style = (overrides: Record<string, string> = {}) => ({
  getPropertyValue: (name: string) => overrides[name] ?? declared.get(name) ?? '',
})

const flat = (palette: ReturnType<typeof resolvePalette>) => palette.flatMap((g) => g.tokens)

describe('token catalogue', () => {
  it('lists every color token in tokens.css, once, and nothing that is not there', () => {
    const listed = TOKEN_GROUPS.flatMap((group) => group.tokens.map((t) => `--color-${t.name}`))
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual([...declared.keys()].sort())
  })

  it('gives every token a role to read it by', () => {
    for (const { role } of TOKEN_GROUPS.flatMap((group) => group.tokens)) {
      expect(role.length).toBeGreaterThan(0)
    }
  })
})

describe('resolvePalette', () => {
  it('measures the shipped palette and finds every token clearing its own bar', () => {
    const tokens = flat(resolvePalette(style()))
    expect(tokens.every((token) => token.color !== null)).toBe(true)
    expect(tokens.filter((token) => token.passes === false)).toEqual([])
  })

  it('reports contrast against the panel, and none for surfaces and the overlay', () => {
    const byName = new Map(flat(resolvePalette(style())).map((token) => [token.name, token]))
    expect(byName.get('fg')?.ratio).toBeCloseTo(13.37, 1)
    expect(byName.get('critical')?.ratio).toBeCloseTo(6.15, 1)
    expect(byName.get('panel')?.ratio).toBeNull()
    expect(byName.get('critical-tint')?.ratio).toBeNull()
    expect(byName.get('scrim')?.ratio).toBeNull()
    // Decorative tokens are measured for information but have no bar to miss.
    expect(byName.get('border')?.ratio).toBeCloseTo(1.35, 1)
    expect(byName.get('border')?.passes).toBeNull()
    expect(byName.get('fg-disabled')?.passes).toBeNull()
  })

  it('names the custom property and keeps the translucent scrim as a color', () => {
    const scrim = flat(resolvePalette(style())).find((token) => token.name === 'scrim')
    expect(scrim?.cssName).toBe('--color-scrim')
    expect(scrim?.color?.[3]).toBeCloseTo(0.72, 2)
  })

  it('reads the live value, so a token dimmed below its bar fails', () => {
    const palette = resolvePalette(style({ '--color-fg-muted': '#3a4853' }))
    const muted = flat(palette).find((token) => token.name === 'fg-muted')
    expect(muted?.passes).toBe(false)
    expect(muted?.ratio).toBeLessThan(4.5)
  })

  it('holds a mark to 3:1 and the ordinal light end to 2:1', () => {
    const palette = resolvePalette(
      style({ '--color-series-2': '#2b545d', '--color-seq-1': '#2b545d' }),
    )
    const byName = new Map(flat(palette).map((token) => [token.name, token]))
    expect(byName.get('series-2')?.passes).toBe(false)
    expect(byName.get('seq-1')?.passes).toBe(true)
  })

  it('degrades to unresolved, with no ratio and no verdict, when the stylesheet is missing', () => {
    const tokens = flat(resolvePalette({ getPropertyValue: () => '' }))
    for (const token of tokens) {
      expect(token.raw).toBe('')
      expect(token.color).toBeNull()
      expect(token.ratio).toBeNull()
      expect(token.passes).toBeNull()
    }
  })
})
