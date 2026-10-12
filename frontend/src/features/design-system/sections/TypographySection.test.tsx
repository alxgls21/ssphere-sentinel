import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import { TypographySection } from './TypographySection'

afterEach(() => vi.restoreAllMocks())

const UTILITIES = [
  'type-hero',
  'type-verdict',
  'type-kpi',
  'type-title',
  'type-body',
  'type-body-strong',
  'type-prompt',
  'type-data',
  'type-data-strong',
  'type-label',
  'type-tag',
  'type-kbd',
  'type-chart',
]

describe('TypographySection', () => {
  it('shows every utility of the scale, applied to a sample', () => {
    renderApp(<TypographySection />)
    for (const name of UTILITIES) {
      const row = screen.getByText(name, { selector: 'code' }).closest('li') as HTMLElement
      expect(row.querySelector(`p.${name}`)).not.toBeNull()
    }
  })

  it('samples Latin and Greek together, because the estate is Greek', () => {
    renderApp(<TypographySection />)
    for (const name of UTILITIES) {
      const sample = (
        screen.getByText(name, { selector: 'code' }).closest('li') as HTMLElement
      ).querySelector(`p.${name}`)?.textContent
      expect(sample, name).toMatch(/[A-Za-z0-9]/)
      expect(sample, name).toMatch(/[Α-ω]/)
    }
  })

  it('reports what the page actually applies: family, size, line height, weight and tracking', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: '11px',
      lineHeight: '16px',
      fontWeight: '500',
      letterSpacing: '0.88px',
    } as CSSStyleDeclaration)
    renderApp(<TypographySection />)
    expect(screen.getAllByText('JetBrains Mono · 11px/16px · 500 · 0.08em')).toHaveLength(
      UTILITIES.length,
    )
  })
})
