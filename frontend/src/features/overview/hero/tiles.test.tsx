import { act } from '@testing-library/react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registryOverrides } from '@/config/testing'
import { createTestApi } from '@/test/render'
import { ContainersTile, DevicesTile, ServersTile, TargetsTile } from './DomainTiles'
import { engine, incident, overview } from '@/features/alerts/testing'
import { AlertsTile } from './AlertsTile'
import { counts, loaded, makeAlerts, makeResource, makeSummary, renderHero } from './testing'

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

const withDevices = (devices: { total: number; counts: ReturnType<typeof counts> }) => {
  const summary = makeSummary()
  summary.devices = devices
  return makeResource({ data: summary })
}

describe('DevicesTile', () => {
  it('counts the SNMP devices the console API counts: the ok ones of the total, problems worst first', () => {
    renderHero(<DevicesTile />, {
      summary: withDevices({
        total: 120,
        counts: counts({ healthy: 100, critical: 3, unknown: 9, idle: 8 }),
      }),
    })
    const link = screen.getByRole('link', {
      name: 'Devices: 100 of 120 ok, 3 critical, 9 unknown, 8 idle, mock data',
    })
    expect(link).toHaveAttribute('href', '/snmp')
    expect(within(link).getByText('100')).toBeInTheDocument()
    expect(within(link).getByText('/120 ok')).toBeInTheDocument()
    expect(link).toHaveTextContent('3 CRIT9 UNKN')
    expect(
      within(link).getByRole('img', { name: 'Devices: 3 critical, 9 unknown, 8 idle, 100 ok' }),
    ).toBeInTheDocument()
  })

  it('takes its total from the API’s scope total, whatever the rows hold', () => {
    renderHero(<DevicesTile />, {
      summary: withDevices({ total: 4200, counts: counts({ healthy: 4000, critical: 200 }) }),
    })
    const link = screen.getByRole('link', { name: /^Devices: 4,?000 of 4,?200 ok/ })
    expect(within(link).getByText(/^\/4,?200 ok$/)).toBeInTheDocument()
  })

  it('says none are monitored, and is not a placeholder, when the API counts none', () => {
    const { container } = renderHero(<DevicesTile />, {
      summary: withDevices({ total: 0, counts: counts() }),
    })
    const link = screen.getByRole('link', { name: 'Devices: 0 of 0 ok, mock data' })
    expect(link).toHaveTextContent('none monitored')
    expect(container.querySelector('[data-planned]')).toBeNull()
  })

  it('is live only when the SNMP feature and the overview counts are read from the API', () => {
    const live = renderHero(<DevicesTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.getByText('live')).toBeInTheDocument()
    live.unmount()
    overrides.set('snmp', { connected: false })
    renderHero(<DevicesTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.queryByText('live')).toBeNull()
  })

  it('is mock over the sample API, which monitors no device and shows none', () => {
    renderHero(<DevicesTile />)
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(screen.queryByText('live')).toBeNull()
  })

  it('shows an error with Retry when the summary fails, like the other counted tiles', async () => {
    const refetch = vi.fn()
    renderHero(<DevicesTile />, {
      summary: makeResource({
        status: 'error',
        data: undefined,
        error: new Error('503'),
        updatedAt: null,
        refetch,
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Devices' }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})

describe('AlertsTile', () => {
  it('counts the open incidents from the API’s counts: open, critical, and the rest as warnings', () => {
    renderHero(<AlertsTile />)
    const link = screen.getByRole('link', {
      name: 'Alerts: 7 open, 3 critical, 5 not acknowledged, mock data',
    })
    expect(link).toHaveAttribute('href', '/alerts')
    expect(within(link).getByText('7')).toBeInTheDocument()
    expect(link).toHaveTextContent('3 CRIT')
    expect(link).toHaveTextContent('4 WARN')
    expect(
      within(link).getByRole('img', { name: 'Open incidents: 3 critical, 4 warning' }),
    ).toBeInTheDocument()
  })

  it('counts an acknowledged incident as open: the figure is the API’s open count, not the unacknowledged one', () => {
    renderHero(<AlertsTile />, {
      alerts: makeAlerts({
        overview: loaded(overview({ open: 4, active: 0, acknowledged: 4, critical: 1 })),
      }),
    })
    const link = screen.getByRole('link', {
      name: /^Alerts: 4 open, 1 critical, 0 not acknowledged/,
    })
    expect(within(link).getByText('4')).toBeInTheDocument()
  })

  it('takes the figures from the whole scope, whatever rows the Overview lists', () => {
    renderHero(<AlertsTile />, {
      alerts: makeAlerts({
        overview: loaded(
          overview({
            open: 1234,
            active: 1000,
            acknowledged: 234,
            critical: 99,
            recent: [incident()],
          }),
        ),
      }),
    })
    expect(
      screen.getByRole('link', { name: /^Alerts: 1,?234 open, 99 critical/ }),
    ).toBeInTheDocument()
  })

  it('says none are open, and is not a placeholder, when the API counts none and the engine runs', () => {
    const { container } = renderHero(<AlertsTile />, {
      alerts: makeAlerts({
        overview: loaded(
          overview({ open: 0, active: 0, acknowledged: 0, critical: 0, recent: [] }),
        ),
      }),
    })
    const link = screen.getByRole('link', {
      name: 'Alerts: 0 open, 0 critical, 0 not acknowledged, mock data',
    })
    expect(link).toHaveTextContent('none open')
    expect(link).not.toHaveTextContent('alert engine')
    expect(container.querySelector('[data-planned]')).toBeNull()
  })

  it.each([
    ['failed', 'alert engine failed'],
    ['stale', 'alert engine stale'],
    ['never_started', 'alert engine never started'],
  ] as const)(
    'says the engine is %s on the tile itself, so none open is not read as good news',
    (state, words) => {
      renderHero(<AlertsTile />, {
        alerts: makeAlerts({
          overview: loaded(
            overview({ open: 0, active: 0, acknowledged: 0, critical: 0, recent: [] }),
          ),
          engine: loaded(engine(state)),
        }),
      })
      const link = screen.getByRole('link', { name: new RegExp(words) })
      // The tile draws it shorter than the spoken name, which keeps "alert engine".
      expect(link).toHaveTextContent(words.replace('alert engine', 'engine'))
      expect(link.querySelector('[data-status="healthy"]')).toBeNull()
    },
  )

  it('says the engine’s state could not be read, and does not claim it runs', () => {
    renderHero(<AlertsTile />, {
      alerts: makeAlerts({
        engine: { ...loaded(engine()), data: undefined, status: 'error', error: new Error('503') },
      }),
    })
    expect(screen.getByRole('link', { name: /alert engine state unavailable/ })).toBeInTheDocument()
  })

  it('is live only over the console API with the alerts feature connected, and mock otherwise', () => {
    const live = renderHero(<AlertsTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.getByText('live')).toBeInTheDocument()
    live.unmount()
    overrides.set('alerts', { connected: false })
    renderHero(<AlertsTile />, { api: createTestApi({ source: 'http' }) })
    expect(screen.queryByText('live')).toBeNull()
  })

  it('is mock over the sample API', () => {
    renderHero(<AlertsTile />)
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(screen.queryByText('live')).toBeNull()
  })

  it('shows a skeleton while loading, and an error with Retry that reloads the shared figures', async () => {
    const refetch = vi.fn()
    renderHero(<AlertsTile />, {
      alerts: makeAlerts({
        overview: {
          ...loaded(overview()),
          status: 'error',
          data: undefined,
          error: new Error('503'),
          updatedAt: null,
          refetch,
        },
      }),
    })
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Alerts' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('keeps the last figures, dimmed and marked stale, when a refresh fails', () => {
    renderHero(<AlertsTile />, {
      alerts: makeAlerts({ overview: loaded(overview(), { error: new Error('flaky') }) }),
    })
    expect(screen.getByRole('link', { name: /^Alerts: 7 open.*, stale$/ })).toBeInTheDocument()
  })

  it('does not read the shared summary: its failure is not this tile’s', () => {
    renderHero(<AlertsTile />, {
      summary: makeResource({ status: 'error', data: undefined, error: new Error('503') }),
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Alerts: 7 open/ })).toBeInTheDocument()
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
      </>,
      { summary: makeResource({ status: 'loading', data: undefined, updatedAt: null }) },
    )
    expect(screen.getByRole('link', { name: 'Servers: loading, mock data' })).toBeInTheDocument()
    expect(container.querySelector('.animate-skeleton')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    // Four tiles read the summary: three skeleton blocks each.
    expect(container.querySelectorAll('.animate-skeleton')).toHaveLength(12)
  })

  it('shows an inline error with Retry per summary-backed tile, and Retry reloads the shared summary', async () => {
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
