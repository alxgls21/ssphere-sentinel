import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Alert } from '@/api/types'
import { createTestApi } from '@/test/render'
import { ContainersTile, ServersTile, TargetsTile } from './DomainTiles'
import { AlertsTile, DevicesTile } from './PlannedTiles'
import { counts, makeResource, makeSummary, renderHero } from './testing'

afterEach(() => vi.useRealTimers())

const alert = (id: string, severity: Alert['severity']): Alert => ({
  id,
  severity,
  state: 'active',
  title: `alert ${id}`,
  message: '',
  subject: { kind: 'server', id: 's1', name: 'edge-gw-02' },
  rule: 'sample',
  siteId: null,
  since: '2026-10-12T13:00:00Z',
})

describe('ServersTile', () => {
  it('shows online of total with problems worst first, and the bar of the whole fleet', () => {
    renderHero(<ServersTile />)
    const link = screen.getByRole('link', {
      name: 'Servers: 15 of 16 online, 1 critical, 2 warning, mock data',
    })
    expect(link).toHaveAttribute('href', '/servers')
    expect(within(link).getByText('15')).toBeInTheDocument()
    expect(within(link).getByText('/16 online')).toBeInTheDocument()
    // Worst first, always: CRIT before WARN, so red is always in the same place.
    expect(link).toHaveTextContent('1 CRIT2 WARN')
    expect(
      within(link).getByRole('img', { name: 'Servers: 1 critical, 2 warning, 13 ok' }),
    ).toBeInTheDocument()
  })

  it('has no sparkline: the backend keeps only the latest state of a server', () => {
    renderHero(<ServersTile />)
    expect(document.querySelector('[aria-label^="Success rate"]')).toBeNull()
  })

  it('shows the OK count when nothing needs a look', () => {
    const summary = makeSummary()
    summary.servers = { total: 16, online: 16, counts: counts({ healthy: 16 }) }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', { name: 'Servers: 16 of 16 online, mock data' })
    expect(link).toHaveTextContent('16 OK')
  })

  it('keeps shape and number but drops the words when three statuses would crowd the tile', () => {
    const summary = makeSummary()
    summary.servers = {
      total: 20,
      online: 16,
      counts: counts({ healthy: 16, warning: 2, critical: 1, unknown: 1 }),
    }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', {
      name: 'Servers: 16 of 20 online, 1 critical, 2 warning, 1 unknown, mock data',
    })
    expect(link).not.toHaveTextContent('CRIT')
    expect(link.querySelectorAll('svg[data-status]')).toHaveLength(3)
  })

  it('says nothing is monitored when the fleet is empty, and draws an empty bar', () => {
    const summary = makeSummary()
    summary.servers = { total: 0, online: 0, counts: counts() }
    renderHero(<ServersTile />, { summary: makeResource({ data: summary }) })
    const link = screen.getByRole('link', { name: 'Servers: 0 of 0 online, mock data' })
    expect(link).toHaveTextContent('none monitored')
    expect(within(link).getByRole('img', { name: 'Servers: none' })).toBeInTheDocument()
  })
})

describe('ContainersTile', () => {
  it('counts running of total and names idle containers, which the bar also draws', () => {
    renderHero(<ContainersTile />)
    const link = screen.getByRole('link', {
      name: 'Containers: 65 of 68 running, 2 critical, 1 warning, 3 idle, mock data',
    })
    expect(link).toHaveAttribute('href', '/docker')
    expect(within(link).getByText('/68 running')).toBeInTheDocument()
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

describe('TargetsTile', () => {
  it('links to Network and is the only tile with the success-rate trend', () => {
    renderHero(
      <>
        <ServersTile />
        <ContainersTile />
        <TargetsTile />
        <DevicesTile />
      </>,
    )
    const link = screen.getByRole('link', {
      name: 'Net targets: 37 of 40 up, 1 critical, 2 warning, mock data',
    })
    expect(link).toHaveAttribute('href', '/network')
    expect(within(link).getByText('/40 up')).toBeInTheDocument()
    const sparklines = document.querySelectorAll('[aria-label^="Success rate"]')
    expect(sparklines).toHaveLength(1)
    expect(link).toContainElement(sparklines[0] as HTMLElement)
    // Decorative: the tile's text carries the numbers.
    expect(sparklines[0]?.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(sparklines[0]).toHaveAccessibleName('Success rate, last hour: 97 to 100 percent, now 99')
  })

  it('says there is no history instead of drawing one', () => {
    const summary = makeSummary()
    summary.targets.successTrend = []
    renderHero(<TargetsTile />, { summary: makeResource({ data: summary }) })
    expect(screen.getByText('no history')).toBeInTheDocument()
  })
})

describe('DevicesTile (planned)', () => {
  it('shows the inventory and that no SNMP data exists, as a plain planned block', () => {
    const { container } = renderHero(<DevicesTile />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('Planned, not implemented')).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.queryByText('mock')).not.toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('in inventory')).toBeInTheDocument()
    expect(screen.getByText('12 no SNMP data')).toBeInTheDocument()
    expect(container.querySelector('svg[data-status="unknown"]')).not.toBeNull()
    expect(container.querySelector('[data-planned="true"]')).toHaveClass('border-dashed')
  })

  it('takes its inventory from the shared summary', () => {
    const summary = makeSummary({
      devices: { inInventory: 3, byType: { router: 1, switch: 1, firewall: 1, other: 0 } },
    })
    renderHero(<DevicesTile />, { summary: makeResource({ data: summary }) })
    expect(screen.getByText('3 no SNMP data')).toBeInTheDocument()
  })
})

describe('AlertsTile (planned)', () => {
  it('shows sample active alerts by severity, loaded on their own, and is not a link', async () => {
    const listAlerts = vi
      .fn()
      .mockResolvedValue([
        alert('1', 'critical'),
        alert('2', 'critical'),
        alert('3', 'warning'),
        alert('4', 'warning'),
        alert('5', 'warning'),
      ])
    const { container } = renderHero(<AlertsTile />, { api: createTestApi({ listAlerts }) })

    expect(await screen.findByText('sample')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(container).toHaveTextContent('2 CRIT3 WARN')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.queryByText('mock')).not.toBeInTheDocument()
    expect(screen.getByText('Planned, not implemented')).toBeInTheDocument()
    expect(listAlerts).toHaveBeenCalledWith(expect.objectContaining({ state: 'active' }))
  })

  it('says there are no sample alerts when the list is empty', async () => {
    renderHero(<AlertsTile />, {
      api: createTestApi({ listAlerts: vi.fn().mockResolvedValue([]) }),
    })
    expect(await screen.findByText('no sample alerts')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('shows an inline error with Retry when the alerts cannot be loaded, and retries', async () => {
    const listAlerts = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue([alert('1', 'warning')])
    renderHero(<AlertsTile />, { api: createTestApi({ listAlerts }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load')
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Alerts' }))
    await waitFor(() => expect(screen.getByText('sample')).toBeInTheDocument())
    expect(listAlerts).toHaveBeenCalledTimes(2)
  })
})

describe('tile states from the shared summary', () => {
  it('shows a skeleton after 150 ms while the summary loads, on every summary-backed tile', () => {
    vi.useFakeTimers()
    const { container } = renderHero(
      <>
        <ServersTile />
        <ContainersTile />
        <TargetsTile />
        <DevicesTile />
      </>,
      { summary: makeResource({ status: 'loading', data: undefined, updatedAt: null }) },
    )
    expect(screen.getByRole('link', { name: 'Servers: loading, mock data' })).toBeInTheDocument()
    expect(container.querySelector('.animate-skeleton')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(container.querySelectorAll('.animate-skeleton').length).toBeGreaterThanOrEqual(4)
  })

  it('shows an inline error with Retry per tile, and Retry reloads the shared summary', async () => {
    const refetch = vi.fn()
    renderHero(
      <>
        <ServersTile />
        <ContainersTile />
        <TargetsTile />
        <DevicesTile />
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
    expect(screen.getAllByRole('alert')).toHaveLength(4)
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Containers' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('keeps the last numbers, dimmed and marked stale, when a refresh fails', () => {
    renderHero(<ServersTile />, {
      summary: makeResource({ error: new Error('flaky') }),
    })
    expect(
      screen.getByRole('link', {
        name: 'Servers: 15 of 16 online, 1 critical, 2 warning, mock data, stale',
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
      online: 14,
      counts: counts({ healthy: 12, warning: 2, critical: 2 }),
    }
    update(makeResource({ data: next }))
    expect(screen.getByText('14')).toHaveClass('animate-flash')
    expect(screen.getByText('65')).not.toHaveClass('animate-flash')
  })
})
