import { screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SentinelApi } from '@/api/client'
import type { SiteEntity } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import type { FeatureId } from '@/config/features'
import { StatTile, type TileContent } from '@/features/overview/hero/StatTile'
import { createTestApi, renderApp } from '@/test/render'
import { EntityCells } from '../entity-cells/EntityCells'
import { Panel } from '../Panel'

/**
 * The provenance contract, on the real components: what a panel, a tile or a cell
 * may call "live" follows its own feature (served by the console API, read by the
 * screen, real data), never the adapter alone. Words and spoken names agree.
 */

const overrides = registryOverrides()
afterEach(overrides.restore)

const api = (source: 'http' | 'mock' | undefined): SentinelApi =>
  ({ ...createTestApi(), source }) as SentinelApi

const tileContent: TileContent = {
  summary: '15 of 16 online, 1 critical',
  value: 15,
  unit: '/16 online',
  detail: <span />,
  bar: <span />,
}
const tile = (features: FeatureId | readonly FeatureId[], label = 'Tile') => (
  <StatTile label={label} features={features} to="/x" status="success" content={tileContent} />
)
const panel = (features: FeatureId | readonly FeatureId[], title = 'Panel') => (
  <Panel title={title} features={features}>
    body
  </Panel>
)

/** The quiet tag in the header of the panel or tile with this name. */
const tagOf = (name: RegExp | string) => {
  const region = screen.getByRole('region', { name })
  return within(region.querySelector('header') as HTMLElement).getByText(/^(live|mock|unverified)/)
    .textContent
}
const linkName = () => screen.getByRole('link').getAttribute('aria-label') ?? ''

describe.each([
  ['A', 'servers', 'Disconnected servers'],
  ['B', 'customers', 'Disconnected Customers'],
] as const)('%s. %s: %s', (_id, feature, _what) => {
  // The servers are read from the console API; this row is about a feature that is not.
  beforeEach(() => overrides.set('servers', { connected: false }))

  it('is not live over an HTTP adapter, as a panel', () => {
    renderApp(panel(feature), { api: api('http') })
    expect(tagOf('Panel')).toBe('mock')
    expect(screen.queryByText('live')).toBeNull()
  })

  it('is not live over an HTTP adapter, as a tile, and says so in its spoken name', () => {
    renderApp(tile(feature), { api: api('http') })
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(screen.queryByText('live')).toBeNull()
    expect(linkName()).toBe('Tile: 15 of 16 online, 1 critical, mock data')
  })
})

describe('C. network: stored by the backend, not served by the console API', () => {
  it('is a placeholder as a panel over an HTTP adapter: no tag, no content, never live', () => {
    renderApp(panel('network'), { api: api('http') })
    const region = screen.getByRole('region', { name: 'Panel' })
    expect(region).toHaveAttribute('data-planned', 'true')
    expect(screen.queryByText('body')).toBeNull()
    expect(screen.queryByText('live')).toBeNull()
    expect(within(region).queryByText(/^(live|mock|unverified)/)).toBeNull()
    expect(screen.getByText('Not connected to the console yet')).toBeInTheDocument()
  })

  it('is a placeholder as a tile: no figure, no link, and it says why in words', () => {
    renderApp(tile('network'), { api: api('http') })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText('live')).toBeNull()
    expect(screen.queryByText('15')).toBeNull()
    expect(screen.getByText('Not connected to the console yet')).toBeInTheDocument()
  })
})

describe('D. site assignment and the overview counts: served and read', () => {
  it.each(['site-links', 'overview'] as const)(
    '%s is live as a panel over an HTTP adapter',
    (feature) => {
      renderApp(panel(feature), { api: api('http') })
      expect(tagOf('Panel')).toBe('live')
    },
  )

  it('is mock over the sample API', () => {
    renderApp(panel('site-links'), { api: api('mock') })
    expect(tagOf('Panel')).toBe('mock')
  })
})

describe('E. a mock-backed tile over an HTTP adapter', () => {
  it('keeps its visual tag and its spoken mock-data warning', () => {
    renderApp(tile(['servers', 'customers'], 'Servers'), { api: api('http') })
    expect(screen.getByText('mock')).toBeVisible()
    expect(screen.getByRole('link', { name: /, mock data$/ })).toBeVisible()
  })

  it('says the same under a mock adapter', () => {
    renderApp(tile(['servers', 'overview'], 'Servers'), { api: api('mock') })
    expect(screen.getByText('mock')).toBeVisible()
    expect(linkName()).toMatch(/, mock data$/)
  })
})

describe('F. an unknown feature over an HTTP adapter', () => {
  const unknown = 'not-in-the-registry' as FeatureId

  it('is not live: its tag says unverified, and so does the spoken name', () => {
    renderApp(tile(unknown), { api: api('http') })
    expect(screen.getByText('unverified')).toBeInTheDocument()
    expect(screen.queryByText('live')).toBeNull()
    expect(linkName()).toBe('Tile: 15 of 16 online, 1 critical, source not verified')
  })

  it('is not live as a panel either', () => {
    renderApp(panel(unknown), { api: api('http') })
    expect(tagOf('Panel')).toBe('unverified')
  })

  it('is not live when a feature entry says its backend is unknown', () => {
    overrides.set('servers', { backend: 'unknown', connected: true })
    renderApp(panel('servers'), { api: api('http') })
    expect(tagOf('Panel')).toBe('unverified')
  })
})

describe('G. a missing source', () => {
  it('is never live, even for a feature marked connected', () => {
    overrides.set('servers', { connected: true })
    renderApp(tile('servers'), { api: api(undefined) })
    expect(screen.getByText('unverified')).toBeInTheDocument()
    expect(screen.queryByText('live')).toBeNull()
    expect(linkName()).toMatch(/, source not verified$/)
  })

  it('is never live for a panel either', () => {
    overrides.set('servers', { connected: true })
    renderApp(panel('servers'), { api: api(undefined) })
    expect(tagOf('Panel')).toBe('unverified')
  })
})

describe('a panel that backs nothing the registry can judge', () => {
  it('is unverified, never live (a component with no feature identity)', () => {
    renderApp(panel([]), { api: api('http') })
    expect(tagOf('Panel')).toBe('unverified')
  })
})

describe('H. a genuinely connected, API-backed feature', () => {
  it('may say live, as a panel', () => {
    overrides.set('servers', { connected: true })
    renderApp(panel('servers'), { api: api('http') })
    expect(tagOf('Panel')).toBe('live')
  })

  it('may say live as a tile, and then carries no mock warning in its name', () => {
    overrides.set('servers', { connected: true })
    renderApp(tile('servers'), { api: api('http') })
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.queryByText('mock')).toBeNull()
    expect(linkName()).toBe('Tile: 15 of 16 online, 1 critical')
  })

  it('is still mock over a mock adapter: demo data is never live', () => {
    overrides.set('servers', { connected: true })
    renderApp(tile('servers'), { api: api('mock') })
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(linkName()).toMatch(/, mock data$/)
  })

  it('is not live if its backend only stores the data, whatever the entry claims', () => {
    overrides.set('network', { connected: true })
    renderApp(tile('network'), { api: api('http') })
    expect(screen.queryByText('live')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Not connected to the console yet')).toBeInTheDocument()
  })
})

describe('I. a mixed adapter: one real feature and one demo feature', () => {
  it('labels each by its own feature, and never lets the real one lend its label', () => {
    overrides.set('servers', { connected: true })
    renderApp(
      <>
        {panel('servers', 'Real')}
        {panel('customers', 'Demo')}
        {panel(['servers', 'customers'], 'Both')}
      </>,
      { api: api('http') },
    )
    expect(tagOf('Real')).toBe('live')
    expect(tagOf('Demo')).toBe('mock')
    // A panel that mixes real and demo figures is not live.
    expect(tagOf('Both')).toBe('mock')
  })

  it('does the same for tiles, visually and in their spoken names', () => {
    overrides.set('servers', { connected: true })
    renderApp(
      <>
        {tile('servers', 'Real')}
        {tile('customers', 'Demo')}
        {tile(['servers', 'customers'], 'Both')}
      </>,
      { api: api('http') },
    )
    const names = screen.getAllByRole('link').map((link) => link.getAttribute('aria-label'))
    expect(names).toEqual([
      'Real: 15 of 16 online, 1 critical',
      'Demo: 15 of 16 online, 1 critical, mock data',
      'Both: 15 of 16 online, 1 critical, mock data',
    ])
    expect(screen.getAllByText('live')).toHaveLength(1)
    expect(screen.getAllByText('mock')).toHaveLength(2)
  })
})

describe('entity cells follow their own feature', () => {
  const entities: SiteEntity[] = [
    { id: 'srv', kind: 'server', name: 'srv', status: 'healthy' },
    { id: 'ctr', kind: 'container', name: 'ctr', status: 'healthy' },
    { id: 'tgt', kind: 'target', name: 'tgt', status: 'healthy' },
  ]
  const cells = () =>
    screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
  const names = () => cells().map((cell) => String(cell))

  it('calls only the connected kinds live, over an HTTP adapter', () => {
    renderApp(<EntityCells variant="grid" entities={entities} label="Grid" />, { api: api('http') })
    const spoken = names().join(' | ')
    expect(spoken).toContain('srv, server, OK')
    expect(spoken).not.toMatch(/srv, server, OK, /)
    // Containers are the overview counts', which the console API serves too.
    expect(spoken).not.toMatch(/ctr, container, OK, /)
    expect(spoken).toMatch(/tgt, target, OK, mock data/)
  })

  it('does not call any kind live while the overview breakdown behind the grid is not connected', () => {
    overrides.set('overview', { connected: false })
    renderApp(<EntityCells variant="grid" entities={entities} label="Grid" />, { api: api('http') })
    for (const name of names()) expect(name).toMatch(/, mock data$/)
  })

  it('does not claim real data for any kind when nothing is connected', () => {
    overrides.set('servers', { connected: false })
    overrides.set('overview', { connected: false })
    renderApp(<EntityCells variant="grid" entities={entities} label="Grid" />, { api: api('http') })
    for (const name of names()) expect(name).toMatch(/, mock data$/)
  })

  it('does not claim it without a source either', () => {
    renderApp(<EntityCells variant="grid" entities={entities} label="Grid" />, {
      api: api(undefined),
    })
    for (const name of names()) expect(name).toMatch(/, source not verified$/)
  })
})
