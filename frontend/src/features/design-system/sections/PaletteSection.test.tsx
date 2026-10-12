import { act, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import { PaletteSection } from './PaletteSection'

let sheet: HTMLStyleElement

const setTokens = (declarations: string) => {
  sheet.textContent = `:root { ${declarations} }`
}

/** A contrast preference the test can flip, like the OS setting it stands for. */
function mockContrastPreference() {
  let more = false
  const listeners = new Set<() => void>()
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        get matches() {
          return query === '(prefers-contrast: more)' && more
        },
        media: query,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  )
  return (next: boolean) => {
    more = next
    act(() => listeners.forEach((listener) => listener()))
  }
}

beforeEach(() => {
  sheet = document.createElement('style')
  document.head.append(sheet)
})
afterEach(() => {
  sheet.remove()
  vi.restoreAllMocks()
})

const swatch = (name: string) => screen.getByText(`--color-${name}`).parentElement as HTMLElement

describe('PaletteSection', () => {
  it('shows the value the page resolves each token to, as uppercase hex', () => {
    setTokens('--color-panel: #10161b; --color-fg: #d5dee5; --color-scrim: rgba(8, 11, 14, 0.72);')
    renderApp(<PaletteSection />)
    expect(within(swatch('fg')).getByText('#D5DEE5')).toBeInTheDocument()
    expect(within(swatch('scrim')).getByText('#080B0E @ 72%')).toBeInTheDocument()
  })

  it('measures text and marks against the panel, and says what bar each must clear', () => {
    setTokens(
      '--color-panel: #10161b; --color-fg: #d5dee5; --color-series-2: #0486f4; --color-border: #253039;',
    )
    renderApp(<PaletteSection />)
    expect(within(swatch('fg')).getByText('13.37:1 on panel')).toBeInTheDocument()
    expect(within(swatch('fg')).getByText('text, AA 4.5:1')).toBeInTheDocument()
    expect(within(swatch('series-2')).getByText('mark, 3:1')).toBeInTheDocument()
    expect(within(swatch('border')).getByText('decorative')).toBeInTheDocument()
  })

  it('shows text tokens as ink, and surfaces without a ratio', () => {
    setTokens('--color-panel: #10161b; --color-fg: #d5dee5;')
    renderApp(<PaletteSection />)
    expect(within(swatch('fg')).getByText('Aa 0123 Αθήνα')).toBeInTheDocument()
    expect(within(swatch('panel')).queryByText(/on panel/)).not.toBeInTheDocument()
    expect(within(swatch('panel')).queryByText('Aa 0123 Αθήνα')).not.toBeInTheDocument()
  })

  it('calls a token that misses its bar a failure, in a word', () => {
    setTokens('--color-panel: #10161b; --color-fg-muted: #3a4853; --color-fg: #d5dee5;')
    renderApp(<PaletteSection />)
    expect(within(swatch('fg-muted')).getByText('FAIL')).toBeInTheDocument()
    expect(within(swatch('fg')).queryByText('FAIL')).not.toBeInTheDocument()
  })

  it('says so when a token did not resolve, and claims no contrast for it', () => {
    setTokens('--color-panel: #10161b;')
    renderApp(<PaletteSection />)
    expect(within(swatch('fg')).getByText('unresolved')).toBeInTheDocument()
    expect(within(swatch('fg')).queryByText(/on panel/)).not.toBeInTheDocument()
  })

  it('prints what the page reports for a value it cannot measure, and claims no contrast', () => {
    setTokens('--color-panel: #10161b; --color-fg: hsl(0 0% 50%);')
    renderApp(<PaletteSection />)
    expect(within(swatch('fg')).getByText('hsl(0 0% 50%)')).toBeInTheDocument()
    expect(within(swatch('fg')).queryByText(/on panel/)).not.toBeInTheDocument()
  })

  it('reads the tokens again when the contrast preference rewrites them', () => {
    setTokens('--color-panel: #10161b; --color-fg: #d5dee5; --color-fg-muted: #a3b1bc;')
    const setMore = mockContrastPreference()
    renderApp(<PaletteSection />)
    expect(within(swatch('fg-muted')).getByText('#A3B1BC')).toBeInTheDocument()

    setTokens('--color-panel: #10161b; --color-fg: #d5dee5; --color-fg-muted: #d5dee5;')
    setMore(true)
    expect(within(swatch('fg-muted')).getByText('#D5DEE5')).toBeInTheDocument()
  })
})
