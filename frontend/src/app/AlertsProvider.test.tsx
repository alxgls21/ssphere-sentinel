import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSearchParams } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { engine, overview } from '@/features/alerts/testing'
import { createTestApi, renderApp } from '@/test/render'
import { AlertsProvider } from './AlertsProvider'
import { useAlerts } from './alerts'

function Probe() {
  const alerts = useAlerts()
  if (!alerts) return <output aria-label="alerts">no provider</output>
  const { overview: o, engine: e } = alerts
  return (
    <output aria-label="alerts">
      {JSON.stringify({
        open: o.data?.open ?? null,
        overview: o.status,
        engine: e.data?.state ?? null,
        engineStatus: e.status,
      })}
    </output>
  )
}

function ScopeSwitch() {
  const [, setParams] = useSearchParams()
  return (
    <button type="button" onClick={() => setParams({ customer: 'acme' })}>
      acme
    </button>
  )
}

const read = () => JSON.parse(screen.getByLabelText('alerts').textContent ?? '{}')

afterEach(() => vi.useRealTimers())

function setup(over: Partial<SentinelApi> = {}, route = '/') {
  const getIncidentOverview = vi.fn<SentinelApi['getIncidentOverview']>(async () => overview())
  const getEngineStatus = vi.fn<SentinelApi['getEngineStatus']>(async () => engine())
  const api = createTestApi({ getIncidentOverview, getEngineStatus, ...over })
  renderApp(
    <AlertsProvider>
      <Probe />
    </AlertsProvider>,
    { api, route, pollMs: 1000 },
  )
  return { getIncidentOverview, getEngineStatus }
}

describe('AlertsProvider', () => {
  it('reads the open incidents of the scope and the engine’s state, once, for the whole shell', async () => {
    const served = setup({}, '/?customer=acme&site=ath')
    await waitFor(() => expect(read()).toMatchObject({ open: 7, engine: 'running' }))
    expect(served.getIncidentOverview).toHaveBeenCalledTimes(1)
    expect(served.getIncidentOverview).toHaveBeenCalledWith({
      scope: { customerId: 'acme', siteId: 'ath' },
      signal: expect.any(AbortSignal),
    })
    expect(served.getEngineStatus).toHaveBeenCalledTimes(1)
  })

  it('asks the engine for no scope: it concerns no customer', async () => {
    const served = setup({}, '/?customer=acme')
    await waitFor(() => expect(read().engine).toBe('running'))
    expect(served.getEngineStatus).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
  })

  it('polls both at the live interval, and no more often', async () => {
    vi.useFakeTimers()
    const served = setup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(served.getIncidentOverview).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(served.getIncidentOverview).toHaveBeenCalledTimes(2)
    expect(served.getEngineStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous count while a new scope loads, and asks again for that scope only', async () => {
    const user = userEvent.setup()
    let release: (value: ReturnType<typeof overview>) => void = () => {}
    const getIncidentOverview = vi
      .fn<SentinelApi['getIncidentOverview']>()
      .mockResolvedValueOnce(overview({ open: 7 }))
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    const getEngineStatus = vi.fn<SentinelApi['getEngineStatus']>(async () => engine())
    renderApp(
      <AlertsProvider>
        <Probe />
        <ScopeSwitch />
      </AlertsProvider>,
      { api: createTestApi({ getIncidentOverview, getEngineStatus }), route: '/' },
    )
    await waitFor(() => expect(read().open).toBe(7))
    await user.click(screen.getByRole('button', { name: 'acme' }))
    await waitFor(() => expect(getIncidentOverview).toHaveBeenCalledTimes(2))
    expect(getIncidentOverview).toHaveBeenLastCalledWith({
      scope: { customerId: 'acme', siteId: null },
      signal: expect.any(AbortSignal),
    })
    // The old count stays until the new one arrives, then gives way to it.
    expect(read()).toMatchObject({ open: 7, overview: 'success' })
    await act(async () => release(overview({ open: 2 })))
    await waitFor(() => expect(read().open).toBe(2))
    // The engine concerns no customer: a scope change does not ask for it again.
    expect(getEngineStatus).toHaveBeenCalledTimes(1)
  })

  it('shows the failure, not a count, when the incidents cannot be read', async () => {
    setup({
      getIncidentOverview: vi.fn(async () => {
        throw new ApiError('Incidents down', 503)
      }),
    })
    await waitFor(() => expect(read()).toMatchObject({ overview: 'error', open: null }))
    expect(read().engine).toBe('running')
  })

  it('shows the failure, not a state, when the engine cannot be read', async () => {
    setup({
      getEngineStatus: vi.fn(async () => {
        throw new ApiError('Engine down', 503)
      }),
    })
    await waitFor(() => expect(read()).toMatchObject({ engineStatus: 'error', engine: null }))
    expect(read().open).toBe(7)
  })

  it('is absent where it is not mounted: a consumer sees no figures, not zeros', () => {
    renderApp(<Probe />)
    expect(screen.getByLabelText('alerts')).toHaveTextContent('no provider')
  })
})
