import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './errors'
import { createMockApi } from './mock/client'
import { composeDemoApi } from './demo'
import type { Scope } from './types'

const REAL_SCOPE = { customers: [{ id: 'uuid-1', name: 'Real Customer' }], sites: [] }
const scope: Scope = { customerId: 'uuid-1', siteId: null }

function compose() {
  const demo = createMockApi({ delayMs: 0 })
  const listServers = vi.spyOn(demo, 'listServers')
  const getOverviewSummary = vi.spyOn(demo, 'getOverviewSummary')
  const real = { getScopeOptions: vi.fn(async () => REAL_SCOPE) }
  return { api: composeDemoApi(demo, real), listServers, getOverviewSummary, real }
}

describe('composeDemoApi', () => {
  it('takes the scope from the real API', async () => {
    const { api, real } = compose()
    const controller = new AbortController()
    await expect(api.getScopeOptions({ signal: controller.signal })).resolves.toEqual(REAL_SCOPE)
    expect(real.getScopeOptions).toHaveBeenCalledWith(controller.signal)
  })

  it('says the data is demo data, so panels are marked as such', () => {
    expect(compose().api.source).toBe('mock')
  })

  it('never hands a real scope to the demo fleet, whose ids mean nothing there', async () => {
    const { api, listServers, getOverviewSummary } = compose()
    const servers = await api.listServers({ scope })
    await api.getOverviewSummary({ scope })
    expect(listServers).toHaveBeenCalledWith({ scope: { customerId: null, siteId: null } })
    expect(getOverviewSummary).toHaveBeenCalledWith({ scope: { customerId: null, siteId: null } })
    // Not emptied by an id it does not know.
    expect(servers.items.length).toBeGreaterThan(0)
  })

  it('does not offer demo servers to search, beside real customers', async () => {
    const index = await compose().api.getEntityIndex()
    expect(index.items).toEqual([])
  })

  it('reports a failed scope request as it is: no sample scope stands in for the real one', async () => {
    const demo = createMockApi({ delayMs: 0 })
    const getScopeOptions = vi.spyOn(demo, 'getScopeOptions')
    const failure = new ApiError('The server is unavailable (HTTP 502).', 502)
    const api = composeDemoApi(demo, { getScopeOptions: vi.fn().mockRejectedValue(failure) })

    await expect(api.getScopeOptions()).rejects.toBe(failure)
    expect(getScopeOptions).not.toHaveBeenCalled()
  })
})
