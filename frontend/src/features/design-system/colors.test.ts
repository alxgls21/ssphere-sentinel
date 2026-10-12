import { describe, expect, it } from 'vitest'
import { contrastRatio, formatColor, formatRatio, luminance, parseColor } from './colors'

describe('parseColor', () => {
  it('reads hex in every length', () => {
    expect(parseColor('#42d99b')).toEqual([66, 217, 155, 1])
    expect(parseColor('  #42D99B ')).toEqual([66, 217, 155, 1])
    expect(parseColor('#0f8')).toEqual([0, 255, 136, 1])
    expect(parseColor('#00ff0080')).toEqual([0, 255, 0, 128 / 255])
    expect(parseColor('#0f88')).toEqual([0, 255, 136, 136 / 255])
  })

  it('reads rgb functions, however the browser spaces them', () => {
    expect(parseColor('rgb(8, 11, 14)')).toEqual([8, 11, 14, 1])
    expect(parseColor('rgba(8,11,14,0.72)')).toEqual([8, 11, 14, 0.72])
    expect(parseColor('rgb(8 11 14 / 72%)')).toEqual([8, 11, 14, 0.72])
  })

  it('answers null for anything it cannot resolve to a color', () => {
    expect(parseColor('')).toBeNull()
    expect(parseColor('var(--color-fg)')).toBeNull()
    expect(parseColor('oklch(0.8 0.1 200)')).toBeNull()
    expect(parseColor('#12')).toBeNull()
    expect(parseColor('#12345')).toBeNull()
    expect(parseColor('rgb(1, 2)')).toBeNull()
    expect(parseColor('rgb(a, b, c)')).toBeNull()
  })
})

describe('formatColor', () => {
  it('prints uppercase hex, and the opacity of a translucent color', () => {
    expect(formatColor([66, 217, 155, 1])).toBe('#42D99B')
    expect(formatColor([8, 11, 14, 0.72])).toBe('#080B0E @ 72%')
    expect(formatColor([0, 0, 0, 1])).toBe('#000000')
  })
})

describe('contrast', () => {
  const black = [0, 0, 0, 1] as const
  const white = [255, 255, 255, 1] as const

  it('spans 1 to 21', () => {
    expect(luminance(black)).toBe(0)
    expect(luminance(white)).toBeCloseTo(1, 10)
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5)
    expect(contrastRatio(white, white)).toBe(1)
  })

  it('does not depend on the order of its arguments', () => {
    const text = parseColor('#d5dee5')
    const panel = parseColor('#10161b')
    if (!text || !panel) throw new Error('fixture colors must parse')
    expect(contrastRatio(text, panel)).toBe(contrastRatio(panel, text))
  })

  it('matches the ratios in the design spec', () => {
    const pairs: [string, string, number][] = [
      ['#d5dee5', '#10161b', 13.37],
      ['#f16b73', '#10161b', 6.15],
      ['#64d8e8', '#10161b', 10.87],
      ['#2b545d', '#10161b', 2.19],
    ]
    for (const [foreground, background, expected] of pairs) {
      const a = parseColor(foreground)
      const b = parseColor(background)
      if (!a || !b) throw new Error('fixture colors must parse')
      expect(contrastRatio(a, b)).toBeCloseTo(expected, 1)
    }
  })

  it('formats a ratio with two decimals', () => {
    expect(formatRatio(13.3712)).toBe('13.37:1')
    expect(formatRatio(21)).toBe('21.00:1')
  })
})
