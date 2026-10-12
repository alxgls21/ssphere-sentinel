import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@/api/mock/client'
import { ApiError } from '@/api/errors'
import { renderApp } from '@/test/render'
import OverviewPage from './OverviewPage'

// The chart needs a canvas, which jsdom does not have: the panel's own tests cover it.
vi.mock('./latency/NetworkLatencyPanel', () => ({
  NetworkLatencyPanel: ({ className }: { className?: string }) => (
    <section aria-label="Network latency" data-panel="2" className={className} />
  ),
}))

const NOW = Date.parse('2026-10-12T14:05:12Z')

function stubViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query.includes('min-width: 64rem'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function setup(wide = true, api = createMockApi({ delayMs: 0, now: () => NOW })) {
  stubViewport(wide)
  return { api, ...renderApp(<OverviewPage />, { api, withSummary: true, withShell: true }) }
}

afterEach(() => vi.unstubAllGlobals())

// jsdom applies no CSS, so the wide hero and the phone bar are both in the DOM: use the hero.
const strip = () => screen.getByRole('region', { name: 'Fleet summary' })
const loaded = () => within(strip()).findByText('CRITICAL')

describe('OverviewPage', () => {
  it('shows the six panels and the summary strip, in reading order', async () => {
    setup()
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    for (const name of [
      'Fleet summary',
      'Needs attention',
      'Network latency',
      'Fleet load',
      'Infrastructure health',
      'Active alerts',
      'Recent events',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument()
    }
    // Each panel is reachable by its number key.
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(document.querySelector(`[data-panel="${index}"]`)).not.toBeNull()
    }
    await loaded()
  })

  it('says the same thing everywhere: the verdict, the queue and the tiles agree', async () => {
    const { api } = setup()
    const summary = await api.getOverviewSummary({})
    const attention = (['servers', 'containers', 'targets'] as const).reduce(
      (sum, domain) =>
        sum +
        summary[domain].counts.critical +
        summary[domain].counts.warning +
        summary[domain].counts.unknown,
      0,
    )
    const queue = await screen.findByRole('region', { name: 'Needs attention' })
    await waitFor(() => expect(within(queue).getAllByRole('row').length).toBeGreaterThan(1))
    const hero = await within(strip()).findByRole('button', { name: /^Fleet status:/ })
    expect(hero.querySelector('.type-hero')).toHaveTextContent(String(attention))
    // The queue's header count is the same number of entities.
    expect(within(queue).getByText(String(attention))).toBeInTheDocument()
  })

  it('marks only the backend-less panels as PLANNED, and every panel as mock', async () => {
    setup()
    await loaded()
    for (const name of ['Active alerts', 'Recent events']) {
      expect(screen.getByRole('region', { name })).toHaveAttribute('data-planned', 'true')
    }
    for (const name of ['Needs attention', 'Fleet load']) {
      const region = screen.getByRole('region', { name })
      expect(region).not.toHaveAttribute('data-planned')
      expect(within(region).getByText(/^mock/)).toBeInTheDocument()
    }
  })

  it('asks the API for the alerts once: the tile and the panel share one resource', async () => {
    const api = createMockApi({ delayMs: 0, now: () => NOW })
    const listAlerts = vi.spyOn(api, 'listAlerts')
    setup(true, api)
    await loaded()
    await waitFor(() => expect(listAlerts).toHaveBeenCalled())
    expect(listAlerts).toHaveBeenCalledTimes(1)
  })

  it('keeps the page alive when one panel fails: it errors alone, with its own Retry', async () => {
    const api = createMockApi({ delayMs: 0, now: () => NOW })
    api.getFleetLoad = () => Promise.reject(new ApiError('load service down', 503))
    setup(true, api)
    const load = screen.getByRole('region', { name: 'Fleet load' })
    expect(await within(load).findByRole('alert')).toHaveTextContent('load service down')
    expect(within(load).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // Everything else is still there.
    expect(await loaded()).toBeInTheDocument()
    const queue = screen.getByRole('region', { name: 'Needs attention' })
    await waitFor(() => expect(within(queue).getAllByRole('row').length).toBeGreaterThan(1))
  })

  it('folds the PLANNED panels into one collapsed section on a narrow screen', async () => {
    setup(false)
    await loaded()
    const folded = screen.getByText(/Planned · backend not implemented \(2\)/)
    const section = folded.closest('details') as HTMLDetailsElement
    expect(section.open).toBe(false)
    expect(
      within(section).getByRole('region', { name: 'Active alerts', hidden: true }),
    ).toBeInTheDocument()
    expect(
      within(section).getByRole('region', { name: 'Recent events', hidden: true }),
    ).toBeInTheDocument()
    await userEvent.click(folded)
    expect(section.open).toBe(true)
  })

  it('shows the PLANNED panels inline on a wide screen, with no accordion', async () => {
    setup(true)
    await loaded()
    expect(screen.queryByText(/Planned · backend not implemented/)).not.toBeInTheDocument()
  })
})
