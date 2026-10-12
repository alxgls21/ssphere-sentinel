import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FEATURES, isUnimplemented } from '@/config/features'
import { NAV_ITEMS } from '@/config/nav'
import { renderApp } from '@/test/render'
import { NotFoundPage } from './NotFoundPage'
import { ScreenPlaceholder } from './ScreenPlaceholder'

const SCREENS = NAV_ITEMS.filter((item) => item.id !== 'overview')

describe('ScreenPlaceholder', () => {
  it.each(SCREENS.map((item) => [item.label, item] as const))(
    '%s: names the screen and says plainly that it has not been designed',
    (_label, item) => {
      renderApp(<ScreenPlaceholder item={item} />)
      expect(screen.getByRole('heading', { level: 1, name: item.label })).toBeInTheDocument()
      expect(screen.getByText('This screen has not been designed yet')).toBeInTheDocument()
      expect(screen.getByText(`${item.description}.`)).toBeInTheDocument()
    },
  )

  it.each(SCREENS.map((item) => [item.label, item] as const))(
    '%s: states what the backend provides, from the readiness registry',
    (_label, item) => {
      renderApp(<ScreenPlaceholder item={item} />)
      const feature = FEATURES[item.feature as NonNullable<typeof item.feature>]
      const status = screen.getByRole('heading', { name: 'Backend status' })
        .parentElement as HTMLElement
      expect(within(status).getByText(feature.note)).toBeInTheDocument()
      expect(within(status).getByText(/./, { selector: '.type-data' })).toBeInTheDocument()
    },
  )

  it.each(SCREENS.map((item) => [item.label, item] as const))(
    '%s: lists what backend work is missing',
    (_label, item) => {
      renderApp(<ScreenPlaceholder item={item} />)
      const section = screen.getByRole('heading', { name: 'Missing in the backend' })
        .parentElement as HTMLElement
      expect(within(section).getAllByRole('listitem').length).toBeGreaterThan(0)
    },
  )

  it('marks screens whose backend feature is not implemented with the PLANNED chip, and only those', () => {
    for (const item of SCREENS) {
      const { unmount } = renderApp(<ScreenPlaceholder item={item} />)
      const planned = isUnimplemented(item.feature as NonNullable<typeof item.feature>)
      expect(screen.queryByText('Planned') !== null, item.label).toBe(planned)
      unmount()
    }
  })

  it('mentions docs/snmp.md for SNMP as plain text in the repository, not as a link', () => {
    const snmp = NAV_ITEMS.find((item) => item.id === 'snmp') as (typeof NAV_ITEMS)[number]
    renderApp(<ScreenPlaceholder item={snmp} />)
    const doc = screen.getByText('docs/snmp.md')
    expect(doc.tagName).toBe('CODE')
    expect(doc.closest('a')).toBeNull()
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Back to Overview',
    ])
  })

  it('mentions documentation only where a document exists', () => {
    const documented = new Set<string>()
    for (const item of SCREENS) {
      const { unmount } = renderApp(<ScreenPlaceholder item={item} />)
      if (screen.queryByRole('heading', { name: 'Documentation' })) documented.add(item.id)
      unmount()
    }
    expect([...documented].sort()).toEqual(['docker', 'network', 'servers', 'snmp'])
  })

  it('links back to Overview, keeping the scope and range of the view', () => {
    const servers = SCREENS[0] as (typeof SCREENS)[number]
    renderApp(<ScreenPlaceholder item={servers} />, { route: '/servers?range=6h&customer=acme' })
    expect(screen.getByRole('link', { name: 'Back to Overview' })).toHaveAttribute(
      'href',
      '/?range=6h&customer=acme',
    )
  })

  it('never claims the screen works', () => {
    for (const item of SCREENS) {
      const { container, unmount } = renderApp(<ScreenPlaceholder item={item} />)
      expect(container.textContent, item.label).not.toMatch(/\b(live|real-time|up to date)\b/i)
      unmount()
    }
  })
})

describe('NotFoundPage', () => {
  it('says which path has no screen and offers the way back', () => {
    renderApp(<NotFoundPage />, { route: '/nope/at/all?range=6h' })
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('/nope/at/all')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Overview' })).toHaveAttribute(
      'href',
      '/?range=6h',
    )
  })

  it('shows an untrusted path as text, never as markup', () => {
    const { container } = renderApp(<NotFoundPage />, { route: '/<img src=x onerror=alert(1)>' })
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('/<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })
})
