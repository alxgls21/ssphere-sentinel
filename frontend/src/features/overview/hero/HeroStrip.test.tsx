import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@/api/mock/client'
import { ShellContext } from '@/app/shell'
import { renderApp } from '@/test/render'
import { HeroStrip } from './HeroStrip'
import { makeResource, makeShell, renderHero } from './testing'

const strip = () => screen.getByRole('region', { name: 'Fleet summary' })

describe('HeroStrip', () => {
  it('is a labelled region holding the verdict, then the five tiles in order', async () => {
    renderHero(<HeroStrip />)
    const region = strip()
    expect(within(region).getByRole('button', { name: /^Fleet status:/ })).toBeInTheDocument()

    const labels = [...region.querySelectorAll('.type-label')].map((label) => label.textContent)
    expect(labels).toEqual(['Servers', 'Containers', 'Net targets', 'Devices', 'Alerts'])
  })

  it('links the five tiles the console API counts, each to its own screen', () => {
    renderHero(<HeroStrip />)
    const links = within(strip()).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/servers',
      '/docker',
      '/network',
      '/snmp',
      '/alerts',
    ])
    // Nothing in the strip is a placeholder any more: every tile has a figure behind it.
    expect(strip().querySelectorAll('[data-planned="true"]')).toHaveLength(0)
    expect(screen.queryByText('Planned')).toBeNull()
    expect(screen.getAllByText('mock')).toHaveLength(5)
  })

  it('has no sparkline on any tile', () => {
    renderHero(<HeroStrip />)
    expect(strip().querySelectorAll('[aria-label^="Success rate"]')).toHaveLength(0)
  })

  it('tabs through the verdict and the five links', async () => {
    renderHero(<HeroStrip />)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /^Fleet status:/ })).toHaveFocus()
    for (const name of [/^Servers:/, /^Containers:/, /^Net targets:/, /^Devices:/, /^Alerts:/]) {
      await userEvent.tab()
      expect(screen.getByRole('link', { name })).toHaveFocus()
    }
    await userEvent.tab()
    expect(strip()).not.toContainElement(document.activeElement as HTMLElement)
  })

  it('lays out the spec grid: one 7.5rem row at xl, two rows at lg, 3 + 2 at md, two columns below', () => {
    const { container } = renderHero(<HeroStrip />)
    const grid = container.querySelector('section') as HTMLElement
    expect(grid).toHaveClass(
      'grid',
      'gap-3',
      'grid-cols-2',
      'auto-rows-[7.5rem]',
      'md:grid-cols-6',
      'md:grid-rows-[5.5rem]',
      'lg:grid-cols-5',
      'xl:grid-cols-[minmax(0,1.7fr)_repeat(5,minmax(0,1fr))]',
      'xl:grid-rows-[7.5rem]',
    )

    // The full verdict yields to the compact bar below md; it spans the width at md and lg.
    const verdict = within(grid).getByRole('button', { name: /^Fleet status:/ }).parentElement
    expect(verdict).toHaveClass(
      'hidden',
      'md:block',
      'md:col-span-6',
      'lg:col-span-5',
      'xl:col-span-1',
    )

    const tile = (name: RegExp) => within(grid).getByRole('link', { name })
    expect(tile(/^Servers:/)).toHaveClass('md:col-span-2', 'lg:col-span-1')
    expect(tile(/^Containers:/)).toHaveClass('md:col-span-2', 'lg:col-span-1')
    // Full width on a phone, so devices and alerts share the last row.
    expect(tile(/^Net targets:/)).toHaveClass('col-span-2', 'lg:col-span-1')
    expect(tile(/^Devices:/)).toHaveClass('md:col-span-3', 'lg:col-span-1')
    expect(tile(/^Alerts:/)).toHaveClass('md:col-span-3', 'lg:col-span-1')
  })

  it('shows the verdict and the summary-backed tiles in their error state, and the alerts tile from its own figures', async () => {
    const refetch = vi.fn()
    renderHero(<HeroStrip />, {
      summary: makeResource({
        status: 'error',
        data: undefined,
        error: new Error('503'),
        updatedAt: null,
        refetch,
      }),
    })
    expect(within(strip()).getByRole('button', { name: /no data/ })).toBeInTheDocument()
    expect(within(strip()).getAllByRole('alert')).toHaveLength(4)
    // The alerts tile does not read the summary: it still shows the open incidents.
    expect(within(strip()).getByRole('link', { name: /^Alerts: 7 open/ })).toBeInTheDocument()
    await userEvent.click(within(strip()).getByRole('button', { name: 'Retry loading Servers' }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})

describe('HeroStrip against the mock API', () => {
  it('shows the same numbers on the verdict and every tile as the shared summary holds', async () => {
    const api = createMockApi({ delayMs: 0 })
    const summary = await api.getOverviewSummary()
    renderApp(
      <ShellContext.Provider value={makeShell()}>
        <HeroStrip />
      </ShellContext.Provider>,
      { api, withSummary: true, withAlerts: true },
    )

    const { servers, containers } = summary
    // The link exists while the tile is still loading, so assert with retry rather than on first sight.
    const link = (label: string) => screen.getByRole('link', { name: new RegExp(`^${label}: `) })
    await waitFor(() => {
      expect(link('Servers')).toHaveTextContent(`${servers.counts.healthy}/${servers.total} ok`)
      expect(link('Containers')).toHaveTextContent(
        `${containers.counts.healthy}/${containers.total} ok`,
      )
    })

    const counted = (['critical', 'warning', 'unknown', 'healthy'] as const).reduce(
      (sum, status) => sum + servers.counts[status] + containers.counts[status],
      0,
    )
    const attention = [servers, containers].reduce(
      (sum, domain) => sum + domain.counts.critical + domain.counts.warning + domain.counts.unknown,
      0,
    )
    const hero = await screen.findByRole('button', { name: /^Fleet status:/ })
    expect(hero).toHaveTextContent(`need attention of ${counted}`)
    expect(hero.querySelector('.type-hero')).toHaveTextContent(String(attention))
  })
})
