import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { EngineStatus, IncidentOverview } from '@/api/types'
import { AlertsContext, type AlertsState } from '@/app/alerts'
import { engine, overview } from '@/features/alerts/testing'
import type { Resource } from '@/hooks/useResource'
import { renderApp } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import { IncidentBell } from './IncidentBell'

function resource<T>(data: T | undefined, over: Partial<Resource<T>> = {}): Resource<T> {
  return {
    status: data === undefined ? 'loading' : 'success',
    data,
    error: null,
    isRefreshing: false,
    updatedAt: data === undefined ? null : Date.now(),
    refetch: vi.fn(),
    ...over,
  }
}

const alerts = (
  open: IncidentOverview | Resource<IncidentOverview> = overview(),
  state: EngineStatus | Resource<EngineStatus> = engine(),
): AlertsState => ({
  overview: 'status' in open ? open : resource(open),
  engine: 'status' in state ? state : resource(state),
})

function Where() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}

function bell(value: AlertsState | null, route = '/') {
  return renderApp(
    <AlertsContext.Provider value={value}>
      <IncidentBell />
      <Routes>
        <Route path="/alerts" element={<p>alerts screen</p>} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </AlertsContext.Provider>,
    { route },
  )
}

const link = () => screen.getByRole('link', { name: /^Alerts: / })

describe('IncidentBell', () => {
  it('shows the number of open incidents, as the API counts them over the whole scope', () => {
    bell(alerts(overview({ open: 7, critical: 3, recent: [] })))
    expect(link()).toHaveTextContent('7')
    expect(link()).toHaveAccessibleName('Alerts: 7 open incidents, 3 critical')
  })

  it('counts an acknowledged incident as open: the figure is the open count, not the active one', () => {
    bell(alerts(overview({ open: 4, active: 0, acknowledged: 4, critical: 0 })))
    expect(link()).toHaveTextContent('4')
    expect(link()).toHaveAccessibleName('Alerts: 4 open incidents')
  })

  it('never counts only what a page loaded: the count is the API’s however few rows were listed', () => {
    bell(alerts(overview({ open: 250, critical: 12, recent: [] })))
    expect(link()).toHaveTextContent('99+')
    expect(link()).toHaveAccessibleName('Alerts: 250 open incidents, 12 critical')
  })

  it('says one incident in the singular, and none as zero, not as nothing', () => {
    const { unmount } = bell(alerts(overview({ open: 1, critical: 0 })))
    expect(link()).toHaveAccessibleName('Alerts: 1 open incident')
    unmount()
    bell(alerts(overview({ open: 0, active: 0, acknowledged: 0, critical: 0, recent: [] })))
    expect(link()).toHaveTextContent('0')
    expect(link()).toHaveAccessibleName('Alerts: 0 open incidents')
  })

  it('opens the Alerts screen, keeping the scope', async () => {
    const user = userEvent.setup()
    bell(alerts(), '/?customer=acme&site=ath')
    expect(link()).toHaveAttribute('href', '/alerts?customer=acme&site=ath')
    await user.click(link())
    expect(await screen.findByText('alerts screen')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/alerts?customer=acme&site=ath')
  })

  it('is reachable with the keyboard and names itself in a tooltip', async () => {
    stubFocusVisible()
    const user = userEvent.setup()
    bell(alerts())
    await user.tab()
    expect(link()).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Alerts: 7 open incidents, 3 critical',
    )
  })

  it('draws no number while there is none to trust, and says it is loading', () => {
    bell(alerts(resource<IncidentOverview>(undefined)))
    expect(link()).toHaveAccessibleName(/loading open incidents/)
    expect(within(link()).queryByText(/^\d+\+?$/)).toBeNull()
  })

  it('says the count could not be read, with a question mark and not a zero', () => {
    bell(
      alerts(resource<IncidentOverview>(undefined, { status: 'error', error: new Error('503') })),
    )
    expect(link()).toHaveTextContent('?')
    expect(link()).toHaveAccessibleName(/open incidents unavailable/)
    expect(link()).not.toHaveTextContent('0')
  })

  it('keeps the last count, and says it may be out of date, when a refresh fails', () => {
    bell(alerts(resource(overview({ open: 5 }), { error: new Error('flaky') })))
    expect(link()).toHaveTextContent('5')
    expect(link()).toHaveAccessibleName(/5 open incidents.*last read may be out of date/)
  })

  it('marks the badge by how bad it is: critical, warning, or neither', () => {
    const tone = () => link().querySelector('span[aria-hidden="true"]') as HTMLElement
    const first = bell(alerts(overview({ open: 3, critical: 1 })))
    expect(tone().className).toMatch(/text-critical/)
    first.unmount()
    const second = bell(alerts(overview({ open: 3, critical: 0 })))
    expect(tone().className).toMatch(/text-warning/)
    second.unmount()
    bell(alerts(overview({ open: 0, active: 0, acknowledged: 0, critical: 0, recent: [] })))
    expect(tone().className).not.toMatch(/text-(critical|warning)/)
  })

  describe('the alert engine', () => {
    it('adds no mark and no words while it runs', () => {
      bell(alerts(overview(), engine('running')))
      expect(link().querySelector('[data-status]')).toBeNull()
      expect(link()).not.toHaveAccessibleName(/engine/)
    })

    it.each([
      ['failed', 'critical', 'alert engine failed'],
      ['stale', 'warning', 'alert engine stale'],
      ['never_started', 'unknown', 'alert engine never started'],
    ] as const)('marks a %s engine beside the number and names it', (state, status, words) => {
      bell(
        alerts(
          overview({ open: 0, active: 0, acknowledged: 0, critical: 0, recent: [] }),
          engine(state),
        ),
      )
      expect(link().querySelector(`[data-status="${status}"]`)).not.toBeNull()
      expect(link()).toHaveAccessibleName(`Alerts: 0 open incidents; ${words}`)
    })

    it('does not draw zero open incidents from an engine that never ran as good news', () => {
      bell(
        alerts(
          overview({ open: 0, active: 0, acknowledged: 0, critical: 0, recent: [] }),
          engine('never_started'),
        ),
      )
      expect(link().querySelector('[data-status="healthy"]')).toBeNull()
      expect(link().querySelector('[data-status="unknown"]')).not.toBeNull()
    })

    it('says its state could not be read, rather than saying nothing', () => {
      bell(
        alerts(
          overview(),
          resource<EngineStatus>(undefined, { status: 'error', error: new Error('503') }),
        ),
      )
      expect(link()).toHaveAccessibleName(/alert engine state unavailable/)
      expect(link().querySelector('[data-status="unknown"]')).not.toBeNull()
    })

    it('is quiet while the engine’s state is still loading', () => {
      bell(alerts(overview(), resource<EngineStatus>(undefined)))
      expect(link().querySelector('[data-status]')).toBeNull()
      expect(link()).not.toHaveAccessibleName(/engine/)
    })
  })

  it('draws nothing where there are no shared alert figures: no provider, no zero', () => {
    bell(null)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
