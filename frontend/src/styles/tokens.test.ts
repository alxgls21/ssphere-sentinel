/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { colorMatrixValues } from '@/features/design-system/vision'

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

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** OKLab of a linear-light sRGB triple (Ottosson), the space color distances are measured in. */
function oklabOfLinear([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
const oklab = (rgb: [number, number, number]) =>
  oklabOfLinear(rgb.map((value) => toLinear(value / 255)) as [number, number, number])

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

  it.each(['primary', 'healthy', 'warning', 'critical', 'offline'])(
    '%s text reaches AA on every surface',
    (token) => {
      for (const surface of surfaces)
        expect(ratio(token, surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(['healthy', 'warning', 'critical', 'offline'])(
    '%s text reaches AA on its own tint',
    (token) => {
      expect(ratio(token, `${token}-tint`)).toBeGreaterThanOrEqual(4.5)
      // ...and secondary text stays legible on that tint too.
      expect(ratio('fg', `${token}-tint`)).toBeGreaterThanOrEqual(4.5)
      expect(ratio('fg-faint', `${token}-tint`)).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('keeps non-text marks at 3:1 against the panel (WCAG 1.4.11)', () => {
    const marks = [
      'primary',
      'healthy',
      'warning',
      'critical',
      'offline',
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
    for (const status of ['healthy', 'warning', 'critical', 'offline'])
      expect(series).not.toContain(hex(status))
  })
})

describe('offline', () => {
  const channels = (name: string) =>
    [1, 3, 5].map((i) => parseInt(hex(name).slice(i, i + 2), 16)) as [number, number, number]

  it('derives its tint and line as 12% and 40% of the hue over the panel, like every status', () => {
    const over = (name: string, share: number) =>
      '#' +
      channels(name)
        .map((value, i) =>
          Math.round(share * value + (1 - share) * channels('panel')[i]!)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
        .toUpperCase()
    for (const status of ['healthy', 'warning', 'critical', 'offline']) {
      expect(hex(`${status}-tint`), `${status}-tint`).toBe(over(status, 0.12))
      expect(hex(`${status}-line`), `${status}-line`).toBe(over(status, 0.4))
    }
  })

  it('is a restrained hue: less chroma than any status or primary, yet more than a neutral grey', () => {
    const chroma = (name: string) => {
      const [, a, b] = oklab(channels(name))
      return Math.hypot(a, b)
    }
    for (const status of ['healthy', 'warning', 'critical', 'primary'])
      expect(chroma('offline'), `offline vs ${status}`).toBeLessThan(chroma(status) * 0.75)
    for (const grey of ['fg-muted', 'fg-faint'])
      expect(chroma('offline')).toBeGreaterThan(chroma(grey) * 2)
  })

  // Marks are told apart by shape and word first; the color still has to be a different color for
  // everyone, so it is held to the separation the other status hues already keep from one another.
  describe('stays distinguishable from the other marks under simulated color vision', () => {
    /** The gallery's own simulation matrices (the 3x3 inside each feColorMatrix), so the two cannot drift apart. */
    const matrixOf = (kind: 'protanopia' | 'deuteranopia' | 'tritanopia'): readonly number[] => {
      const values = colorMatrixValues(kind).split(' ').map(Number)
      return [0, 1, 2].flatMap((row) => values.slice(row * 5, row * 5 + 3))
    }
    const vision = {
      normal: null,
      protanopia: matrixOf('protanopia'),
      deuteranopia: matrixOf('deuteranopia'),
      tritanopia: matrixOf('tritanopia'),
    }
    const separation = (a: string, b: string, kind: keyof typeof vision): number => {
      const matrix = vision[kind]
      const seen = (name: string) => {
        const linear = channels(name).map((value) => toLinear(value / 255)) as [
          number,
          number,
          number,
        ]
        if (!matrix) return linear
        const clamp = (value: number) => Math.min(1, Math.max(0, value))
        return [0, 1, 2].map((row) =>
          clamp(
            matrix[row * 3]! * linear[0] +
              matrix[row * 3 + 1]! * linear[1] +
              matrix[row * 3 + 2]! * linear[2],
          ),
        ) as [number, number, number]
      }
      const [l1, a1, b1] = oklabOfLinear(seen(a))
      const [l2, a2, b2] = oklabOfLinear(seen(b))
      return 100 * Math.hypot(l1 - l2, a1 - a2, b1 - b2)
    }
    const kinds = Object.keys(vision) as (keyof typeof vision)[]

    it.each(['critical', 'warning', 'healthy', 'primary'])('from %s', (other) => {
      for (const kind of kinds)
        expect(separation('offline', other, kind), `${other}, ${kind}`).toBeGreaterThanOrEqual(10)
    })

    // A low-chroma hue sits nearest the neutral greys, so they get a floor of their own. Normal
    // vision, protanopia and deuteranopia hold 6 (offline measures 6.9 to 7.7; the palette's weakest
    // status-to-grey pairs sit near 7). Without short-wavelength cones a blue-violet collapses
    // toward grey: it measures 4.6 there, so that floor is 4. A steel blue would clear 6 under all
    // four, but only by sitting closer to fg-faint in normal vision (about 6.5), so the shape and
    // the word carry the state.
    it.each(['fg-muted', 'fg-faint'])('from the neutral grey %s', (grey) => {
      for (const kind of kinds) {
        const floor = kind === 'tritanopia' ? 4 : 6
        expect(separation('offline', grey, kind), `${grey}, ${kind}`).toBeGreaterThanOrEqual(floor)
      }
    })
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
      /\b(?:text|bg|border|fill|stroke|ring|outline|from|to|via|decoration)-(?:healthy|warning|critical|offline)(?:-(?:tint|line))?\b/
    const offenders = files
      .filter(({ path, text }) => !allowed.some((dir) => path.startsWith(dir)) && status.test(text))
      .map(({ path }) => path)
    expect(
      offenders,
      'render health with <StatusGlyph/>, <StatusTag/> or the meters so shape + word always accompany color',
    ).toEqual([])
  })
})
