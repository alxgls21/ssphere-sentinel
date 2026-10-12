import type { HealthStatus } from '@/api/types'

/** The status alphabet on its 10x10 grid: the same paths StatusGlyph draws. */
const SHAPE: Record<HealthStatus, (ink: string) => string> = {
  healthy: (ink) => `<circle cx="5" cy="5" r="4" fill="${ink}"/>`,
  warning: (ink) => `<path d="M5 1 L9.2 8.6 H0.8 Z" fill="${ink}"/>`,
  critical: (ink) => `<path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="${ink}"/>`,
  idle: (ink) => `<rect x="0.8" y="3.4" width="8.4" height="3.2" rx="0.6" fill="${ink}"/>`,
  unknown: (ink) =>
    `<circle cx="5" cy="5" r="3.4" fill="none" stroke="${ink}" stroke-width="1.5"/>`,
}

/** Which token colors each shape, as StatusGlyph does. */
const INK_TOKEN: Record<HealthStatus, string> = {
  healthy: '--color-healthy',
  warning: '--color-warning',
  critical: '--color-critical',
  idle: '--color-fg-muted',
  unknown: '--color-fg-faint',
}

/**
 * A data URL for an SVG favicon carrying the verdict's shape in its color; with
 * mock data it also carries a hatched corner, so a pinned tab is marked too.
 * Colors are read from the design tokens at runtime (the one color source), so
 * this returns null, and the static favicon stays, where the tokens are not
 * loaded.
 */
export function faviconHref(status: HealthStatus, mock: boolean): string | null {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const ground = token('--color-bg')
  const ink = token(INK_TOKEN[status])
  const hatch = token('--color-fg-muted')
  if (!ground || !ink || !hatch) return null

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    `<rect width="32" height="32" rx="3" fill="${ground}"/>`,
    `<g transform="translate(4 4) scale(2.4)">${SHAPE[status](ink)}</g>`,
    mock
      ? `<path d="M32 21L21 32M32 27L27 32" stroke="${hatch}" stroke-width="2.4" fill="none"/>`
      : '',
    '</svg>',
  ].join('')
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Points the page's icon link at `href`, creating the link if the document has none. */
export function setFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.append(link)
  }
  link.type = 'image/svg+xml'
  link.href = href
}
