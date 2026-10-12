/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')
const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8')

/** --color-name: #RRGGBB (the rgba scrim is not a text/mark color and is skipped). */
const tokens = new Map<string, string>()
for (const match of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) {
  tokens.set(match[1] as string, (match[2] as string).toUpperCase())
}
const hex = (name: string): string => {
  const value = tokens.get(name)
  if (!value) throw new Error(`missing token --color-${name}`)
  return value
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const ratio = (fg: string, bg: string) => contrast(hex(fg), hex(bg))

describe('palette', () => {
  it('keeps the mandated brand values exactly', () => {
    expect(hex('bg')).toBe('#080B0E')
    expect(hex('panel')).toBe('#10161B')
    expect(hex('border')).toBe('#253039')
    expect(hex('primary')).toBe('#64D8E8')
    expect(hex('healthy')).toBe('#42D99B')
    expect(hex('warning')).toBe('#F5BD4F')
    expect(hex('critical')).toBe('#F16B73')
    expect(hex('fg')).toBe('#D5DEE5')
  })

  const surfaces = ['bg', 'panel', 'raised', 'hover', 'primary-tint']

  it.each(['fg', 'fg-muted', 'fg-faint'])(
    'text token %s reaches AA (4.5:1) on every surface',
    (token) => {
      for (const surface of surfaces)
        expect(ratio(token, surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(['primary', 'healthy', 'warning', 'critical'])(
    '%s text reaches AA on every surface',
    (token) => {
      for (const surface of surfaces)
        expect(ratio(token, surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(['healthy', 'warning', 'critical'])('%s text reaches AA on its own tint', (token) => {
    expect(ratio(token, `${token}-tint`)).toBeGreaterThanOrEqual(4.5)
    // ...and secondary text stays legible on that tint too.
    expect(ratio('fg', `${token}-tint`)).toBeGreaterThanOrEqual(4.5)
    expect(ratio('fg-faint', `${token}-tint`)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps non-text marks at 3:1 against the panel (WCAG 1.4.11)', () => {
    const marks = [
      'primary',
      'healthy',
      'warning',
      'critical',
      'border-control',
      'series-2',
      'series-3',
      'series-4',
      'series-other',
      'fg-muted',
      'fg-faint',
      'seq-2',
      'seq-3',
      'seq-4',
    ]
    for (const mark of marks)
      expect(ratio(mark, 'panel'), `${mark} on panel`).toBeGreaterThanOrEqual(3)
  })

  it('keeps the ordinal light end of the cyan ramp at 2:1', () => {
    expect(ratio('seq-1', 'panel')).toBeGreaterThanOrEqual(2)
  })

  describe('dimmed (stale) content', () => {
    // Persistent staleness dims marks and large figures only: at 60% opacity the small text tokens
    // fall below AA, so they must never sit under that opacity.
    const STALE_OPACITY = 0.6
    const blended = (fg: string, bg: string) => {
      const mix = (i: number) => {
        const f = parseInt(hex(fg).slice(i, i + 2), 16)
        const b = parseInt(hex(bg).slice(i, i + 2), 16)
        return Math.round(STALE_OPACITY * f + (1 - STALE_OPACITY) * b)
          .toString(16)
          .padStart(2, '0')
      }
      return `#${mix(1)}${mix(3)}${mix(5)}`.toUpperCase()
    }

    it('keeps the large figure at 3:1 (large-text AA) when dimmed', () => {
      expect(contrast(blended('fg', 'panel'), hex('panel'))).toBeGreaterThanOrEqual(3)
    })

    it.each(['fg-muted', 'fg-faint'])(
      'would drop small %s text below AA: it must stay undimmed',
      (token) => {
        expect(contrast(blended(token, 'panel'), hex('panel'))).toBeLessThan(4.5)
      },
    )
  })

  it('keeps ink on solid primary fills legible', () => {
    expect(ratio('bg', 'primary')).toBeGreaterThanOrEqual(4.5)
    expect(ratio('bg', 'primary-hover')).toBeGreaterThanOrEqual(4.5)
    expect(ratio('bg', 'primary-press')).toBeGreaterThanOrEqual(4.5)
  })

  it('never lets a status hue impersonate a chart series', () => {
    const series = ['primary', 'series-2', 'series-3', 'series-4', 'series-other'].map(hex)
    for (const status of ['healthy', 'warning', 'critical'])
      expect(series).not.toContain(hex(status))
  })
})

describe('token discipline', () => {
  // Every source file as text, so tokens.css really is the only place a color may be written.
  const files: { path: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push({
          path: relative(SRC, full).split('\\').join('/'),
          text: readFileSync(full, 'utf8'),
        })
      }
    }
  }
  walk(SRC)

  it('has no color literals outside tokens.css', () => {
    const offenders = files
      .filter(
        ({ path, text }) =>
          path !== 'styles/tokens.css' &&
          (/#[0-9a-fA-F]{3,8}\b/.test(text) || /\b(rgba?|hsla?|oklch|oklab)\(/.test(text)),
      )
      .map(({ path }) => path)
    expect(
      offenders,
      'use tokens (Tailwind utilities or var(--color-*)) instead of color literals',
    ).toEqual([])
  })

  it('uses status color utilities only inside ui/status, ui/meters and charts', () => {
    const allowed = ['ui/status/', 'ui/meters/', 'charts/', 'styles/']
    const status =
      /\b(?:text|bg|border|fill|stroke|ring|outline|from|to|via|decoration)-(?:healthy|warning|critical)(?:-(?:tint|line))?\b/
    const offenders = files
      .filter(({ path, text }) => !allowed.some((dir) => path.startsWith(dir)) && status.test(text))
      .map(({ path }) => path)
    expect(
      offenders,
      'render health with <StatusGlyph/>, <StatusTag/> or the meters so shape + word always accompany color',
    ).toEqual([])
  })
})
