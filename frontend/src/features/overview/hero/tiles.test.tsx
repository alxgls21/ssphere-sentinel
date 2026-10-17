import { act } from '@testing-library/react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registryOverrides } from '@/config/testing'
import { createTestApi } from '@/test/render'
import { ContainersTile, ServersTile, TargetsTile } from './DomainTiles'
import { AlertsTile, DevicesTile } from './PlannedTiles'
import { counts, makeResource, makeSummary, renderHero } from './testing'

const overrides = registryOverrides()
afterEach(() => {
  overrides.restore()
  vi.useRealTimers()
})

describe('provenance of the domain tiles', () => {
  it('is mock over the sample API', () => {
    renderHero(<ServersTile />)
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(screen.queryByText('live')).toBeNull()
  })

  it('is live when the summary is read from the console API', () => {
    renderHero(<ServersTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.queryByText('mock')).toBeNull()
    expect(
      screen.getByRole('link', { name: 'Servers: 13 of 16 ok, 1 critical, 2 warning' }),
    ).toBeVisible()
  })

  it('is live for containers too: the console API serves both', () => {
    renderHero(<ContainersTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.getByText('live')).toBeInTheDocument()
  })
})

describe('ServersTile', () => {
  it('shows the ok count of the total with problems worst first, and the bar of the whole fleet', () => {
    renderHero(<ServersTile />)
    const link = screen.getByRole('link', {
      name: 'Servers: 13 of 16 ok, 1 critical, 2 warning, mock data',
    })
    expect(link).toHaveAttribute('href', '/servers')
    expect(within(link).getByText('13')).toBeInTheDocument()
    expect(within(link).getByText('/16 ok')).toBeInTheDocument()
    // Worst first, always: CRIT before WARN, so red is always in the same place.
    expect(link).toHaveTextContent('1 CRIT2 WARN')
    expect(
      within(link).getByRole('img', { name: 'Servers: 1 critical, 2 warning, 13 ok' }),
    ).toBeInTheDocument()
  })

  it('shows an offline server apart from critical, in the line, the bar and the name', () => {
    const summary = makeSummary()
    summary.servers = {
      total: 16,
      counts: counts({ healthy: 13, warning: 2, critical: 1, offline: 1 }),
    }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', {
      name: 'Servers: 13 of 16 ok, 1 offline, 2 warning, mock data',
    })
    // Two marks still fit the tile with their words, and offline wears its own shape.
    expect(link).toHaveTextContent('1 OFFL2 WARN')
    expect(link.querySelector('svg[data-status="offline"]')).not.toBeNull()
    expect(link.querySelector('svg[data-status="critical"]')).toBeNull()
    expect(
      within(link).getByRole('img', { name: 'Servers: 1 offline, 2 warning, 13 ok' }),
    ).toBeInTheDocument()
  })

  it('drops the words, not the marks, when an offline server makes a third', () => {
    const summary = makeSummary()
    summary.servers = {
      total: 16,
      counts: counts({ healthy: 11, warning: 2, critical: 2, offline: 1, unknown: 1 }),
    }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', {
      name: 'Servers: 11 of 16 ok, 1 critical, 1 offline, 2 warning, 1 unknown, mock data',
    })
    expect(link).not.toHaveTextContent('OFFL')
    expect(
      [...link.querySelectorAll('svg[data-status]')].map((glyph) =>
        glyph.getAttribute('data-status'),
      ),
    ).toEqual(['critical', 'offline', 'warning', 'unknown'])
  })

  it('has no sparkline: the backend keeps only the latest state of a server', () => {
    renderHero(<ServersTile />)
    expect(document.querySelector('[aria-label^="Success rate"]')).toBeNull()
  })

  it('shows the OK count when nothing needs a look', () => {
    const summary = makeSummary()
    summary.servers = { total: 16, counts: counts({ healthy: 16 }) }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', { name: 'Servers: 16 of 16 ok, mock data' })
    expect(link).toHaveTextContent('16 OK')
  })

  it('keeps shape and number but drops the words when three statuses would crowd the tile', () => {
    const summary = makeSummary()
    summary.servers = {
      total: 20,
      counts: counts({ healthy: 16, warning: 2, critical: 1, unknown: 1 }),
    }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', {
      name: 'Servers: 16 of 20 ok, 1 critical, 2 warning, 1 unknown, mock data',
    })
    expect(link).not.toHaveTextContent('CRIT')
    expect(link.querySelectorAll('svg[data-status]')).toHaveLength(3)
  })

  it('says nothing is monitored when the fleet is empty, and draws an empty bar', () => {
    const summary = makeSummary()
    summary.servers = { total: 0, counts: counts() }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', { name: 'Servers: 0 of 0 ok, mock data' })
    expect(link).toHaveTextContent('none monitored')
    expect(within(link).getByRole('img', { name: 'Servers: none' })).toBeInTheDocument()
  })
})

describe('ContainersTile', () => {
  it('counts the ok containers of the total and names idle ones, which the bar also draws', () => {
    renderHero(<ContainersTile />)
    const link = screen.getByRole('link', {
      name: 'Containers: 62 of 68 ok, 2 critical, 1 warning, 3 idle, mock data',
    })
    expect(link).toHaveAttribute('href', '/docker')
    expect(within(link).getByText('/68 ok')).toBeInTheDocument()
    const bar = within(link).getByRole('img', {
      name: 'Containers: 2 critical, 1 warning, 3 idle, 62 ok',
    })
    expect(bar.querySelector('[data-status="idle"]')).not.toBeNull()
    // Idle is neutral: it never appears among the problem counts.
    expect(link).toHaveTextContent('2 CRIT1 WARN')
    expect(link).not.toHaveTextContent('IDLE')
  })

  it('has no sparkline', () => {
    renderHero(<ContainersTile />)
    expect(document.querySelector('[aria-label^="Success rate"]')).toBeNull()
  })
})

const withTargets = (targets: { total: number; counts: ReturnType<typeof counts> }) => {
  const summary = makeSummary()
  summary.targets = targets
  return makeResource({ data: summary })
}

describe('TargetsTile', () => {
  it('counts the targets the console API counts: the ok ones of the total, problems worst first', () => {
    renderHero(<TargetsTile />, {
      summary: withTargets({
        total: 40,
        counts: counts({ healthy: 33, warning: 2, critical: 1, unknown: 4 }),
      }),
    })
    const link = screen.getByRole('link', {
      name: 'Net targets: 33 of 40 ok, 1 critical, 2 warning, 4 unknown, mock data',
    })
    expect(link).toHaveAttribute('href', '/network')
    expect(within(link).getByText('33')).toBeInTheDocument()
    expect(within(link).getByText('/40 ok')).toBeInTheDocument()
    expect(
      within(link).getByRole('img', {
        name: 'Net targets: 1 critical, 2 warning, 4 unknown, 33 ok',
      }),
    ).toBeInTheDocument()
  })

  it('names the idle (disabled) ones in the spoken name and the bar, but not among the problems', () => {
    renderHero(<TargetsTile />, {
      summary: withTargets({ total: 12, counts: counts({ healthy: 9, critical: 1, idle: 2 }) }),
    })
    const link = screen.getByRole('link', {
      name: 'Net targets: 9 of 12 ok, 1 critical, 2 idle, mock data',
    })
    expect(link).toHaveTextContent('1 CRIT')
    expect(link).not.toHaveTextContent('IDLE')
  })

  it('says none are monitored, and is not a placeholder, when the API counts none', () => {
    const { container } = renderHero(<TargetsTile />, {
      summary: withTargets({ total: 0, counts: counts() }),
    })
    const link = screen.getByRole('link', { name: 'Net targets: 0 of 0 ok, mock data' })
    expect(link).toHaveTextContent('none monitored')
    expect(container.querySelector('[data-planned]')).toBeNull()
  })

  it('is live only when the whole Network feature and the overview counts are read from the API', () => {
    const live = renderHero(<TargetsTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.getByText('live')).toBeInTheDocument()
    live.unmount()
    overrides.set('network', { connected: false })
    renderHero(<TargetsTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.queryByText('live')).toBeNull()
  })

  it('shows a skeleton while loading and an error with Retry, like the other counted tiles', async () => {
    const refetch = vi.fn()
    renderHero(<TargetsTile />, {
      summary: makeResource({
        status: 'error',
        data: undefined,
        error: new Error('503'),
        updatedAt: null,
        refetch,
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Net targets' }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})

describe('the tiles of what the console API does not serve', () => {
  it('shows no figure, no link and no inventory for SNMP devices', () => {
    const { container } = renderHero(<DevicesTile />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('Devices')).toBeInTheDocument()
    expect(screen.getByText('Not served by the console API')).toBeInTheDocument()
    expect(container.querySelector('.type-kpi')).toBeNull()
    expect(container).not.toHaveTextContent(/\d/)
    expect(screen.queryByText('mock')).not.toBeInTheDocument()
  })

  it('says alerts are not implemented in the backend, with no count and no sample', () => {
    const { container } = renderHero(<AlertsTile />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('Planned, not implemented')).toBeInTheDocument()
    expect(screen.getByText('Not implemented in the backend')).toBeInTheDocument()
    expect(screen.queryByText('sample')).not.toBeInTheDocument()
    expect(screen.queryByText('mock')).not.toBeInTheDocument()
    expect(container.querySelector('.type-kpi')).toBeNull()
    expect(container).not.toHaveTextContent(/\d/)
  })

  it('stays the same whatever the summary says, and whatever the API source is', () => {
    const live = renderHero(<DevicesTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.getByText('Not served by the console API')).toBeInTheDocument()
    expect(screen.queryByText('live')).not.toBeInTheDocument()
    live.unmount()
    renderHero(<DevicesTile />, {
      summary: makeResource({ status: 'error', data: undefined, error: new Error('503') }),
    })
    // A failed summary is not a failed tile: nothing is read for it.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Not served by the console API')).toBeInTheDocument()
  })
})

describe('tile states from the shared summary', () => {
  it('shows a skeleton after 150 ms while the summary loads, on the summary-backed tiles only', () => {
    vi.useFakeTimers()
    const { container } = renderHero(
      <>
        <ServersTile />
        <ContainersTile />
        <TargetsTile />
        <DevicesTile />
        <AlertsTile />
      </>,
      { summary: makeResource({ status: 'loading', data: undefined, updatedAt: null }) },
    )
    expect(screen.getByRole('link', { name: 'Servers: loading, mock data' })).toBeInTheDocument()
    expect(container.querySelector('.animate-skeleton')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    // Three tiles read the summary: three skeleton blocks each.
    expect(container.querySelectorAll('.animate-skeleton')).toHaveLength(9)
  })

  it('shows an inline error with Retry per summary-backed tile, and Retry reloads the shared summary', async () => {
    const refetch = vi.fn()
    renderHero(
      <>
        <ServersTile />
        <ContainersTile />
        <TargetsTile />
        <DevicesTile />
        <AlertsTile />
      </>,
      {
        summary: makeResource({
          status: 'error',
          data: undefined,
          error: new Error('503'),
          updatedAt: null,
          refetch,
        }),
      },
    )
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(3)
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Containers' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('keeps the last numbers, dimmed and marked stale, when a refresh fails', () => {
    renderHero(<ServersTile />, {
      summary: makeResource({ error: new Error('flaky') }),
    })
    expect(
      screen.getByRole('link', {
        name: 'Servers: 13 of 16 ok, 1 critical, 2 warning, mock data, stale',
      }),
    ).toBeInTheDocument()
  })

  it('dims every tile once the data has gone stale', () => {
    vi.useFakeTimers()
    const { store } = renderHero(<ServersTile />)
    store.report('summary', { updatedAt: Date.now(), failed: false, fetching: false })
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByRole('link', { name: /, stale$/ })).toBeInTheDocument()
  })

  it('flashes a tile value when a new snapshot changes it, and only that tile', () => {
    const { update } = renderHero(
      <>
        <ServersTile />
        <ContainersTile />
      </>,
    )
    const next = makeSummary()
    next.servers = {
      total: 16,
      counts: counts({ healthy: 12, warning: 2, critical: 2 }),
    }
    update(makeResource({ data: next }))
    expect(screen.getByText('12')).toHaveClass('animate-flash')
    expect(screen.getByText('62')).not.toHaveClass('animate-flash')
  })
})
