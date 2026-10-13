import type { SentinelApi } from './client'
import type { ScopeOptions } from './types'
import { ALL_SCOPE } from './types'

/**
 * The console API serves the session and the scope; every other screen still
 * reads built-in demo data. This composes the two behind the one SentinelApi
 * port, and keeps them apart:
 *
 *  - the scope options are real (the user's own customers and sites);
 *  - the demo methods never see that scope: its ids mean nothing to the demo
 *    fleet, and demo servers must not look like they belong to a real customer;
 *  - the demo fleet is not offered to search, so a fictional server is never
 *    listed beside real ones.
 *
 * Each method moves to the real side as its backend phase is integrated.
 */
export function composeDemoApi(
  demo: SentinelApi,
  real: { getScopeOptions: (signal?: AbortSignal) => Promise<ScopeOptions> },
): SentinelApi {
  const unscoped = <O extends { scope?: unknown }>(options: O | undefined): O | undefined =>
    options && { ...options, scope: ALL_SCOPE }
  return {
    // The data is demo data, whatever the scope is.
    source: 'mock',
    getScopeOptions: (options) => real.getScopeOptions(options?.signal),
    getOverviewSummary: (options) => demo.getOverviewSummary(unscoped(options)),
    listAttention: (options) => demo.listAttention(unscoped(options)),
    getNetworkSeries: (options) => demo.getNetworkSeries(unscoped(options)!),
    getFleetLoad: (options) => demo.getFleetLoad(unscoped(options)!),
    getHealthBreakdown: (options) => demo.getHealthBreakdown(unscoped(options)),
    listAlerts: (options) => demo.listAlerts(unscoped(options)),
    listEvents: (options) => demo.listEvents(unscoped(options)),
    getEntityIndex: async () => ({ generatedAt: new Date().toISOString(), items: [] }),
    listServers: (options) => demo.listServers(unscoped(options)),
    getServer: (id, options) => demo.getServer(id, options),
    getServerSeries: (options) => demo.getServerSeries(options),
  }
}
