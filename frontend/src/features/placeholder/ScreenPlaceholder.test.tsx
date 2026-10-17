import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AVAILABILITY_WORD, FEATURES, isPlaceholder, shortfallOf } from '@/config/features'
import { NAV_ITEMS } from '@/config/nav'
import { renderApp } from '@/test/render'
import { NotFoundPage } from './NotFoundPage'
import { ScreenPlaceholder } from './ScreenPlaceholder'

const SCREENS = NAV_ITEMS.filter((item) => !item.designed)

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
    '%s: lists what is still missing',
    (_label, item) => {
      renderApp(<ScreenPlaceholder item={item} />)
      const section = screen.getByRole('heading', { name: 'Not available yet' })
        .parentElement as HTMLElement
      expect(within(section).getAllByRole('listitem').length).toBeGreaterThan(0)
    },
  )

  it('marks a screen with the chip its availability calls for, and only those that need one', () => {
    for (const item of SCREENS) {
      const feature = item.feature as NonNullable<typeof item.feature>
      const { unmount } = renderApp(<ScreenPlaceholder item={item} />)
      // Only a screen with nothing but a placeholder behind it takes a chip.
      const gap = shortfallOf(feature)
      const chip = gap && isPlaceholder(feature) ? AVAILABILITY_WORD[gap] : null
      for (const word of ['Planned', 'Needs setup', 'Not connected']) {
        expect(
          screen.queryAllByText(word, { selector: 'span' }).length > 0,
          `${item.label} ${word}`,
        ).toBe(word === chip)
      }
      unmount()
    }
  })

  describe('says what is true of each feature', () => {
    const byId = (id: string) =>
      NAV_ITEMS.find((nav) => nav.id === id) as (typeof NAV_ITEMS)[number]
    const text = () => document.body.textContent ?? ''

    it('Docker: the console API serves containers; the screen is what is missing', () => {
      renderApp(<ScreenPlaceholder item={byId('docker')} />)
      expect(text()).toContain('Served by the console API; this screen is not connected to it yet')
      expect(text()).not.toMatch(/read API/i)
      expect(text()).not.toContain('Not implemented in the backend')
    })

    it('a screen on a feature the backend does not implement says so, and is marked Planned', () => {
      renderApp(<ScreenPlaceholder item={{ ...byId('customers'), feature: 'events' }} />)
      expect(text()).toContain('Not implemented in the backend')
      expect(screen.getByText('Planned')).toBeInTheDocument()
    })

    it('Customers & Sites: customers and sites are listed by the console API already', () => {
      renderApp(<ScreenPlaceholder item={byId('customers')} />)
      expect(text()).toContain('lists the customers and sites you may see')
      expect(text()).not.toContain('A Site link')
    })

    it('never shows a chip for a feature that only has no screen yet', () => {
      for (const id of ['docker', 'network', 'customers']) {
        expect(shortfallOf(FEATURES[id as keyof typeof FEATURES].id)).toBe('not-connected')
      }
    })
  })

  it('mentions documentation only where a document exists', () => {
    const documented = new Set<string>()
    for (const item of SCREENS) {
      const { unmount } = renderApp(<ScreenPlaceholder item={item} />)
      if (screen.queryByRole('heading', { name: 'Documentation' })) documented.add(item.id)
      unmount()
    }
    expect([...documented].sort()).toEqual([])
  })

  it('links back to Overview, keeping the scope and range of the view', () => {
    const first = SCREENS[0] as (typeof SCREENS)[number]
    renderApp(<ScreenPlaceholder item={first} />, { route: '/docker?range=6h&customer=acme' })
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
