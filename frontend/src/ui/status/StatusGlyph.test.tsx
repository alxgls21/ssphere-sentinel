import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusGlyph, type GlyphSize } from './StatusGlyph'
import { STATUS_NAME, STATUS_TEXT, STATUS_WORD, type GlyphShape } from './style'

const SHAPES: readonly GlyphShape[] = [
  'healthy',
  'warning',
  'critical',
  'offline',
  'unknown',
  'idle',
  'planned',
]
const SIZES: readonly GlyphSize[] = [6, 10, 12, 16, 24]

const drawing = (status: GlyphShape, size: GlyphSize) => {
  const { container, unmount } = render(<StatusGlyph status={status} size={size} />)
  const svg = container.querySelector('svg') as SVGSVGElement
  const markup = svg.innerHTML
  const outline = svg.querySelector('path')?.getAttribute('d') ?? null
  unmount()
  return { markup, outline }
}

describe('StatusGlyph', () => {
  it.each(SHAPES)('draws %s at every size as one svg carrying its state', (status) => {
    for (const size of SIZES) {
      const { container, unmount } = render(<StatusGlyph status={status} size={size} />)
      const svgs = container.querySelectorAll('svg')
      expect(svgs, `${status} ${size}`).toHaveLength(1)
      const svg = svgs[0] as SVGSVGElement
      expect(svg).toHaveAttribute('data-status', status)
      expect(svg).toHaveAttribute('viewBox', '0 0 10 10')
      expect(svg).toHaveClass(STATUS_TEXT[status])
      expect(svg.childElementCount, `${status} ${size} shapes`).toBe(1)
      unmount()
    }
  })

  it('is decorative until it is given a label, then an image with that name', () => {
    const { container, rerender } = render(<StatusGlyph status="offline" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).toBeNull()
    rerender(<StatusGlyph status="offline" label="server offline" />)
    expect(screen.getByRole('img', { name: 'server offline' })).toHaveAttribute(
      'data-status',
      'offline',
    )
  })

  it('sizes itself on the 6, 10, 12, 16 and 24px grid', () => {
    const classes = SIZES.map((size) => {
      const { container, unmount } = render(<StatusGlyph status="healthy" size={size} />)
      const value = container.querySelector('svg')?.getAttribute('class') ?? ''
      unmount()
      return value
    })
    expect(classes[0]).toContain('size-1.5')
    expect(classes[1]).toContain('size-2.5')
    expect(classes[2]).toContain('size-3')
    expect(classes[3]).toContain('size-4')
    expect(classes[4]).toContain('size-6')
  })

  it('paints only with currentColor, so forced colors and print keep the shape', () => {
    for (const status of SHAPES) {
      for (const size of SIZES) {
        const { markup } = drawing(status, size)
        expect(markup, `${status} ${size}`).toContain('currentColor')
        expect(markup, `${status} ${size}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|url\(/i)
        // No masks, clip paths, filters, gradients or ids: the cue is part of the one path.
        expect(markup, `${status} ${size}`).not.toMatch(
          /<(mask|clipPath|filter|linearGradient|radialGradient|defs|use)\b|\bid=/,
        )
      }
    }
  })

  it('cuts the cue out of the silhouette with an evenodd path from 10px', () => {
    for (const status of ['healthy', 'warning', 'critical', 'offline'] as const) {
      for (const size of [10, 12, 16, 24] as const) {
        const { container, unmount } = render(<StatusGlyph status={status} size={size} />)
        const path = container.querySelector('path')
        expect(path, `${status} ${size}`).toHaveAttribute('fill-rule', 'evenodd')
        // More than one subpath: the silhouette and what is cut from it.
        expect(path?.getAttribute('d')?.match(/M/g)?.length, `${status} ${size}`).toBeGreaterThan(1)
        unmount()
      }
    }
  })

  it('keeps healthy a plain quiet dot at 6px and gives it a check from 10px', () => {
    const quiet = drawing('healthy', 6)
    expect(quiet.markup).toContain('<circle')
    expect(quiet.outline).toBeNull()
    expect(drawing('healthy', 10).outline).not.toBeNull()
  })

  it('draws the plain silhouette below 10px, and no cue', () => {
    for (const status of ['warning', 'critical', 'offline', 'unknown'] as const) {
      const small = drawing(status, 6)
      const large = drawing(status, 12)
      expect(small.markup, status).not.toEqual(large.markup)
      expect(small.markup, status).not.toContain('evenodd')
    }
  })

  it('adds the question mark to the unknown ring only where it can be read', () => {
    expect(drawing('unknown', 10).outline).toBe(drawing('unknown', 12).outline)
    expect(drawing('unknown', 16).outline).toBe(drawing('unknown', 24).outline)
    expect(drawing('unknown', 16).outline).not.toBe(drawing('unknown', 12).outline)
  })

  describe('offline', () => {
    it('has a silhouette unlike any other state at every size', () => {
      for (const size of SIZES) {
        const offline = drawing('offline', size).markup
        for (const other of SHAPES.filter((shape) => shape !== 'offline')) {
          expect(offline, `offline vs ${other} at ${size}px`).not.toEqual(
            drawing(other, size).markup,
          )
        }
      }
    })

    it('differs from critical in shape, word, spoken name and color', () => {
      expect(drawing('offline', 12).outline).not.toBe(drawing('critical', 12).outline)
      expect(STATUS_WORD.offline).toBe('OFFL')
      expect(STATUS_WORD.offline).not.toBe(STATUS_WORD.critical)
      expect(STATUS_NAME.offline).toBe('offline')
      expect(STATUS_TEXT.offline).toBe('text-offline')
      expect(STATUS_TEXT.offline).not.toBe(STATUS_TEXT.critical)
    })
  })

  it('merges a class name onto the svg', () => {
    const { container } = render(<StatusGlyph status="idle" className="absolute" />)
    expect(container.querySelector('svg')).toHaveClass('absolute', 'text-fg-muted')
  })
})
