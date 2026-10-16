import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StatusGlyph } from '@/ui/status'
import { faviconHref, setFavicon } from './favicon'

// Stand-ins for the design tokens: the real values live only in tokens.css.
const TOKENS = {
  '--color-bg': 'ground-token',
  '--color-healthy': 'healthy-token',
  '--color-warning': 'warning-token',
  '--color-critical': 'critical-token',
  '--color-fg-muted': 'muted-token',
  '--color-fg-faint': 'faint-token',
}

function decode(href: string | null): string {
  expect(href).not.toBeNull()
  return decodeURIComponent((href as string).replace('data:image/svg+xml,', ''))
}

beforeEach(() => {
  for (const [name, value] of Object.entries(TOKENS)) {
    document.documentElement.style.setProperty(name, value)
  }
})

afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.head.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove())
})

describe('faviconHref', () => {
  it('draws the verdict’s shape in the token color on the ground color', () => {
    const critical = decode(faviconHref('critical', false))
    expect(critical).toContain('fill="critical-token"')
    expect(critical).toContain('fill="ground-token"')
    expect(critical).toContain('M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z')

    expect(decode(faviconHref('warning', false))).toContain('M5 1 L9.2 8.6 H0.8 Z')
    expect(decode(faviconHref('healthy', false))).toContain(
      '<circle cx="5" cy="5" r="4" fill="healthy-token"/>',
    )
  })

  it.each(['healthy', 'warning', 'critical', 'unknown', 'idle'] as const)(
    'draws %s as StatusGlyph draws it at 6px',
    (status) => {
      const icon = new DOMParser().parseFromString(
        decode(faviconHref(status, false)),
        'image/svg+xml',
      )
      const { container } = render(createElement(StatusGlyph, { status, size: 6 }))
      // Whatever paints the shape (a token color here, currentColor there) is the ink.
      const ink = /^(?:currentColor|[a-z]+-token)$/
      const drawn = (shape: Element | null | undefined) => ({
        tag: shape?.tagName,
        attributes: Object.fromEntries(
          [...(shape?.attributes ?? [])].map(({ name, value }) => [
            name,
            ink.test(value) ? 'ink' : value,
          ]),
        ),
      })
      const inIcon = drawn(icon.querySelector('g')?.firstElementChild)
      expect(inIcon.tag).toBeDefined()
      expect(inIcon).toEqual(drawn(container.querySelector('svg')?.firstElementChild))
    },
  )

  it('draws the unknown ring hollow', () => {
    const unknown = decode(faviconHref('unknown', false))
    expect(unknown).toContain('fill="none" stroke="faint-token"')
  })

  it('adds the hatched corner only for mock data', () => {
    expect(decode(faviconHref('critical', true))).toContain('stroke="muted-token"')
    expect(decode(faviconHref('critical', false))).not.toContain('muted-token')
  })

  it('is a data URL an <link rel="icon"> can use', () => {
    expect(faviconHref('healthy', true)).toMatch(/^data:image\/svg\+xml,%3Csvg/)
  })

  it('returns null where the tokens are not loaded, so the static favicon stays', () => {
    document.documentElement.removeAttribute('style')
    expect(faviconHref('critical', true)).toBeNull()
  })
})

describe('setFavicon', () => {
  it('points the existing icon link at the new image', () => {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = '/favicon.svg'
    document.head.append(link)
    setFavicon('data:image/svg+xml,x')
    expect(document.querySelectorAll('link[rel~="icon"]')).toHaveLength(1)
    expect(link.getAttribute('href')).toBe('data:image/svg+xml,x')
    expect(link.type).toBe('image/svg+xml')
  })

  it('creates the link when the page has none', () => {
    setFavicon('data:image/svg+xml,y')
    expect(document.querySelector('link[rel~="icon"]')?.getAttribute('href')).toBe(
      'data:image/svg+xml,y',
    )
  })
})
