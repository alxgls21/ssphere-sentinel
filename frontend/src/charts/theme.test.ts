/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHART_COLOR_TOKENS,
  buildChartTheme,
  cssColor,
  readChartTokens,
  readRootFontSize,
} from './theme'

const css = readFileSync(join(import.meta.dirname, '..', 'styles', 'tokens.css'), 'utf8')

/** Every `--name: value;` declaration in tokens.css (values keep their source spelling). */
const declared = new Map<string, string>()
for (const match of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+?);/g)) {
  declared.set(match[1] as string, (match[2] as string).replace(/\s*\/\*.*$/, '').trim())
}
const token = (name: string): string => {
  const value = declared.get(name)
  if (!value) throw new Error(`missing token ${name}`)
  return value
}

/** jsdom loads no stylesheet: publish the tokens on :root the way @theme static does in the app. */
function publishTokens(root: HTMLElement) {
  for (const [name, value] of declared) {
    if (name.startsWith('--color-') || name === '--font-mono') root.style.setProperty(name, value)
  }
}

function stubMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => publishTokens(document.documentElement))
afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-motion')
  vi.unstubAllGlobals()
})

describe('chart theme', () => {
  it('only references tokens that tokens.css declares', () => {
    for (const name of Object.values(CHART_COLOR_TOKENS))
      expect(declared.has(name), name).toBe(true)
    expect(declared.has('--font-mono')).toBe(true)
  })

  it('resolves every color from the design tokens, never a second definition', () => {
    const { colors, fontFamily } = readChartTokens()
    for (const [key, name] of Object.entries(CHART_COLOR_TOKENS)) {
      expect(colors[key as keyof typeof colors], key).toBe(token(name))
    }
    expect(fontFamily).toBe(token('--font-mono'))
  })

  it('uses the series slots in fixed order on a transparent surface', () => {
    const theme = buildChartTheme()
    expect(theme.color).toEqual([
      token('--color-primary'),
      token('--color-series-2'),
      token('--color-series-3'),
      token('--color-series-4'),
      token('--color-series-other'),
    ])
    expect(theme.backgroundColor).toBe('transparent')
  })

  it('sets 11px mono fg-faint text', () => {
    expect(buildChartTheme().textStyle).toEqual({
      fontFamily: token('--font-mono'),
      fontSize: 11,
      color: token('--color-fg-faint'),
    })
  })

  it('draws solid horizontal hairlines only, a border baseline and no ticks', () => {
    const { valueAxis, timeAxis, categoryAxis } = buildChartTheme()
    expect(valueAxis.splitLine).toEqual({
      show: true,
      lineStyle: { color: token('--color-chart-grid'), width: 1, type: 'solid' },
    })
    expect(valueAxis.axisLine.show).toBe(false)
    for (const axis of [timeAxis, categoryAxis]) {
      expect(axis.splitLine.show).toBe(false)
      expect(axis.axisLine).toEqual({
        show: true,
        lineStyle: { color: token('--color-border'), width: 1 },
      })
    }
    for (const axis of [valueAxis, timeAxis, categoryAxis]) {
      expect(axis.axisTick.show).toBe(false)
      expect(axis.axisLabel.color).toBe(token('--color-fg-faint'))
      expect(axis.axisLabel.fontSize).toBe(11)
      expect(axis.axisLabel.hideOverlap).toBe(true)
    }
  })

  it('styles the tooltip as a raised overlay with a snapping hairline crosshair', () => {
    const { tooltip } = buildChartTheme()
    expect(tooltip).toMatchObject({
      backgroundColor: token('--color-raised'),
      borderColor: token('--color-border-strong'),
      borderWidth: 1,
      borderRadius: 4,
      padding: 8,
      confine: true,
      transitionDuration: 0,
      hideDelay: 100,
      axisPointer: {
        type: 'line',
        snap: true,
        lineStyle: { color: token('--color-border-control'), width: 1, type: 'solid' },
      },
    })
  })

  it('animates 400 ms first draw and 300 ms updates with cubicOut, and enables aria', () => {
    stubMotion(false)
    expect(buildChartTheme()).toMatchObject({
      animation: true,
      animationDuration: 400,
      animationDurationUpdate: 300,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicOut',
      aria: { enabled: true },
    })
  })

  it('turns animation off under prefers-reduced-motion', () => {
    stubMotion(true)
    expect(buildChartTheme().animation).toBe(false)
  })

  it('turns animation off when the Display menu forces reduced motion', () => {
    stubMotion(false)
    document.documentElement.dataset.motion = 'reduce'
    expect(buildChartTheme().animation).toBe(false)
  })

  it('keeps decals opt-in: off by default, on under forced-colors or more contrast', () => {
    stubMotion(false)
    expect(buildChartTheme().aria.decal.show).toBe(false)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(forced-colors: active)',
      media: query,
    }))
    expect(buildChartTheme().aria.decal.show).toBe(true)
  })

  it('scales type and geometry with the root font size (wall mode)', () => {
    document.documentElement.style.fontSize = '20px'
    expect(readRootFontSize()).toBe(20)
    const theme = buildChartTheme()
    expect(theme.textStyle.fontSize).toBe(13.75)
    expect(theme.valueAxis.axisLabel.fontSize).toBe(13.75)
    expect(theme.tooltip).toMatchObject({ padding: 10 })
  })

  it('exposes the same colors to DOM parts as CSS variables', () => {
    expect(cssColor('series2')).toBe('var(--color-series-2)')
    expect(cssColor('primary')).toBe('var(--color-primary)')
  })
})
