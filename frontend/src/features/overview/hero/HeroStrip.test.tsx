import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@/api/mock/client'
import { ShellContext } from '@/app/shell'
import { createTestApi, renderApp } from '@/test/render'
import { AlertsProvider } from '../AlertsProvider'
import { HeroStrip } from './HeroStrip'
import { makeResource, makeShell, renderHero } from './testing'

const noAlerts = () => createTestApi({ listAlerts: vi.fn().mockResolvedValue([]) })

const strip = () => screen.getByRole('region', { name: 'Fleet summary' })

describe('HeroStrip', () => {
  it('is a labelled region holding the verdict, then the five tiles in order', async () => {
    renderHero(<HeroStrip />, { api: noAlerts() })
    const region = strip()
    expect(within(region).getByRole('button', { name: /^Fleet status:/ })).toBeInTheDocument()
    await within(region).findByText('sample')

    const labels = [...region.querySelectorAll('.type-label')].map((label) => label.textContent)
    expect(labels).toEqual(['Servers', 'Containers', 'Net targets', 'Devices', 'Alerts'])
  })

  it('links the three implemented tiles to their screens and leaves the planned two inert', async () => {
    renderHero(<HeroStrip />, { api: noAlerts() })
    const links = within(strip()).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/servers',
      '/docker',
      '/network',
    ])
    await screen.findByText('sample')
    expect(screen.getAllByText('Planned')).toHaveLength(2)
    expect(screen.getAllByText('mock')).toHaveLength(3)
  })

  it('has the sparkline on the targets tile only', async () => {
    renderHero(<HeroStrip />, { api: noAlerts() })
    await screen.findByText('sample')
    expect(strip().querySelectorAll('[aria-label^="Success rate"]')).toHaveLength(1)
  })

  it('tabs through the verdict and the three links, and not through the planned tiles', async () => {
    renderHero(<HeroStrip />, { api: noAlerts() })
    await screen.findByText('sample')
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /^Fleet status:/ })).toHaveFocus()
    for (const name of [/^Servers:/, /^Containers:/, /^Net targets:/]) {
      await userEvent.tab()
      expect(screen.getByRole('link', { name })).toHaveFocus()
    }
    await userEvent.tab()
    expect(strip()).not.toContainElement(document.activeElement as HTMLElement)
  })

  it('lays out the spec grid: one 7.5rem row at xl, two rows at lg, 3 + 2 at md, two columns below', () => {
    const { container } = renderHero(<HeroStrip />, { api: noAlerts() })
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
    // Full width on a phone, so the two planned tiles share the last row.
    expect(tile(/^Net targets:/)).toHaveClass('col-span-2', 'lg:col-span-1')
  })

  it('shows every tile and the verdict in their loading and error states together', async () => {
    const refetch = vi.fn()
    renderHero(<HeroStrip />, {
      api: createTestApi({ listAlerts: vi.fn().mockRejectedValue(new Error('503')) }),
      summary: makeResource({
        status: 'error',
        data: undefined,
        error: new Error('503'),
        updatedAt: null,
        refetch,
      }),
    })
    expect(within(strip()).getByRole('button', { name: /no data/ })).toBeInTheDocument()
    await waitFor(() => expect(within(strip()).getAllByRole('alert')).toHaveLength(5))
    await userEvent.click(within(strip()).getByRole('button', { name: 'Retry loading Devices' }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})

describe('HeroStrip against the mock API', () => {
  it('shows the same numbers on the verdict and every tile as the shared summary holds', async () => {
    const api = createMockApi({ delayMs: 0 })
    const summary = await api.getOverviewSummary()
    renderApp(
      <ShellContext.Provider value={makeShell()}>
        <AlertsProvider>
          <HeroStrip />
        </AlertsProvider>
      </ShellContext.Provider>,
      { api, withSummary: true },
    )

    const { servers, containers, targets } = summary
    // The link exists while the tile is still loading, so assert with retry rather than on first sight.
    const link = (label: string) => screen.getByRole('link', { name: new RegExp(`^${label}: `) })
    await waitFor(() => {
      expect(link('Servers')).toHaveTextContent(`${servers.online}/${servers.total} online`)
      expect(link('Containers')).toHaveTextContent(
        `${containers.running}/${containers.total} running`,
      )
      expect(link('Net targets')).toHaveTextContent(`${targets.up}/${targets.total} up`)
    })

    const counted = (['critical', 'warning', 'unknown', 'healthy'] as const).reduce(
      (sum, status) =>
        sum + servers.counts[status] + containers.counts[status] + targets.counts[status],
      0,
    )
    const attention = [servers, containers, targets].reduce(
      (sum, domain) => sum + domain.counts.critical + domain.counts.warning + domain.counts.unknown,
      0,
    )
    const hero = await screen.findByRole('button', { name: /^Fleet status:/ })
    expect(hero).toHaveTextContent(`need attention of ${counted}`)
    expect(hero.querySelector('.type-hero')).toHaveTextContent(String(attention))
    expect(await screen.findByText('in inventory')).toBeInTheDocument()
  })
})
