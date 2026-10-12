import { contrastRatio, parseColor, type Rgba } from './colors'

/**
 * Every --color-* token, grouped the way the design system reasons about it.
 * `use` says which bar a token must clear against the panel, so the gallery can
 * check the live value (including the prefers-contrast override) the same way
 * src/styles/tokens.test.ts checks the file. A test keeps this list in step with
 * tokens.css: add a token there and it must be placed here.
 */
export type TokenUse = 'surface' | 'text' | 'mark' | 'ordinal' | 'decorative' | 'exempt' | 'overlay'

export interface TokenSpec {
  /** The name after --color-. */
  name: string
  /** Where it is used, in a few words. */
  role: string
  use: TokenUse
}

export interface TokenGroup {
  id: string
  label: string
  tokens: readonly TokenSpec[]
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: 'surfaces',
    label: 'Surfaces',
    tokens: [
      { name: 'bg', role: 'Page canvas, input wells', use: 'surface' },
      { name: 'panel', role: 'Panels, tiles, chart surface', use: 'surface' },
      { name: 'raised', role: 'Popovers, keycaps, table header', use: 'surface' },
      { name: 'hover', role: 'Row and ghost button wash', use: 'surface' },
      { name: 'primary-tint', role: 'Selected row, active segment', use: 'surface' },
    ],
  },
  {
    id: 'borders',
    label: 'Borders',
    tokens: [
      { name: 'border', role: 'Panel frames, dividers', use: 'decorative' },
      { name: 'border-strong', role: 'Hovered frames, overlays, PLANNED', use: 'decorative' },
      { name: 'border-control', role: 'Control outlines', use: 'mark' },
      { name: 'chart-grid', role: 'Chart gridlines', use: 'decorative' },
    ],
  },
  {
    id: 'text',
    label: 'Text',
    tokens: [
      { name: 'fg', role: 'Primary ink', use: 'text' },
      { name: 'fg-muted', role: 'Secondary text, units', use: 'text' },
      { name: 'fg-faint', role: 'Axis ticks, ages, UNKN ring', use: 'text' },
      { name: 'fg-disabled', role: 'Disabled controls only', use: 'exempt' },
    ],
  },
  {
    id: 'primary',
    label: 'Primary (cyan)',
    tokens: [
      { name: 'primary', role: 'Focus, links, selection, series 1', use: 'text' },
      { name: 'primary-hover', role: 'Link and button hover', use: 'text' },
      { name: 'primary-press', role: 'Button pressed', use: 'text' },
      { name: 'primary-line', role: 'Focused panel frame', use: 'decorative' },
    ],
  },
  {
    id: 'status',
    label: 'Status',
    tokens: [
      { name: 'healthy', role: 'OK glyph and word', use: 'text' },
      { name: 'warning', role: 'WARN glyph and word', use: 'text' },
      { name: 'critical', role: 'CRIT glyph and word', use: 'text' },
    ],
  },
  {
    id: 'status-tints',
    label: 'Status tints',
    tokens: [
      { name: 'healthy-tint', role: 'NOMINAL block, OK tag', use: 'surface' },
      { name: 'warning-tint', role: 'DEGRADED block, WARN tag', use: 'surface' },
      { name: 'critical-tint', role: 'CRITICAL block, CRIT tag', use: 'surface' },
    ],
  },
  {
    id: 'status-lines',
    label: 'Status lines',
    tokens: [
      { name: 'healthy-line', role: 'Verdict frame when NOMINAL', use: 'decorative' },
      { name: 'warning-line', role: 'Verdict frame when DEGRADED', use: 'decorative' },
      { name: 'critical-line', role: 'Verdict frame when CRITICAL', use: 'decorative' },
    ],
  },
  {
    id: 'series',
    label: 'Chart series',
    tokens: [
      { name: 'series-2', role: 'Azure: loss, second series', use: 'mark' },
      { name: 'series-3', role: 'Magenta: third series', use: 'mark' },
      { name: 'series-4', role: 'Indigo: fourth, direct labels', use: 'mark' },
      { name: 'series-other', role: 'Slate: p50, context', use: 'mark' },
    ],
  },
  {
    id: 'sequential',
    label: 'Sequential ramp',
    tokens: [
      { name: 'seq-1', role: 'Lowest magnitude', use: 'ordinal' },
      { name: 'seq-2', role: 'Step 2', use: 'mark' },
      { name: 'seq-3', role: 'Step 3', use: 'mark' },
      { name: 'seq-4', role: 'Step 4 (step 5 is primary)', use: 'mark' },
    ],
  },
  {
    id: 'overlay',
    label: 'Overlay',
    tokens: [{ name: 'scrim', role: 'Behind palette and sheets', use: 'overlay' }],
  },
]

/** The bar each use must clear against the panel. Decorative, exempt, surface and overlay have none. */
const MINIMUM: Partial<Record<TokenUse, number>> = { text: 4.5, mark: 3, ordinal: 2 }

/** What a use asks of its token, in words, shown beside the measured ratio. */
export const REQUIREMENT: Record<TokenUse, string> = {
  surface: 'surface',
  text: 'text, AA 4.5:1',
  mark: 'mark, 3:1',
  ordinal: 'ordinal, 2:1',
  decorative: 'decorative',
  exempt: 'disabled, exempt',
  overlay: 'overlay',
}

export interface ResolvedToken extends TokenSpec {
  /** The custom property, e.g. --color-bg. */
  cssName: string
  /** The value the page resolves it to; empty when the stylesheet is not loaded. */
  raw: string
  color: Rgba | null
  /** Contrast against the panel; null for surfaces, overlays and values that did not resolve. */
  ratio: number | null
  /** true or false against the minimum for its use; null when it has none. */
  passes: boolean | null
}

export interface ResolvedGroup {
  id: string
  label: string
  tokens: readonly ResolvedToken[]
}

const cssName = (name: string) => `--color-${name}`

/** Resolves every token from a computed style (the root element's). */
export function resolvePalette(
  style: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
): ResolvedGroup[] {
  const read = (name: string) => style.getPropertyValue(cssName(name)).trim()
  const panel = parseColor(read('panel'))

  return TOKEN_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    tokens: group.tokens.map((spec): ResolvedToken => {
      const raw = read(spec.name)
      const color = parseColor(raw)
      const measurable = spec.use !== 'surface' && spec.use !== 'overlay'
      const ratio = measurable && panel && color ? contrastRatio(color, panel) : null
      const minimum = MINIMUM[spec.use]
      return {
        ...spec,
        cssName: cssName(spec.name),
        raw,
        color,
        ratio,
        passes: ratio !== null && minimum !== undefined ? ratio >= minimum : null,
      }
    }),
  }))
}
