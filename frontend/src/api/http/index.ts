import type { AuthClient } from '../auth'
import type { SentinelApi } from '../client'
import type { ScopeOptions } from '../types'
import { listContainers } from './containers'
import { getDevice, getDeviceSeries, getInterfaceSeries, listDevices } from './devices'
import { getTarget, getTargetSeries, listTargets } from './targets'
import { createAuthClient, getScopeOptions } from './session'
import { getFleetLoad, getServer, getServerSeries, listServers } from './servers'
import { createTransport, type TransportOptions } from './transport'

/** The console API, request by request. Every method validates its answer. */
export interface ConsoleHttp extends Pick<
  SentinelApi,
  | 'listServers'
  | 'getServer'
  | 'getServerSeries'
  | 'getFleetLoad'
  | 'listTargets'
  | 'getTarget'
  | 'getTargetSeries'
  | 'listDevices'
  | 'getDevice'
  | 'getDeviceSeries'
  | 'getInterfaceSeries'
> {
  auth: AuthClient
  getScopeOptions: (signal?: AbortSignal) => Promise<ScopeOptions>
  listContainers: ReturnType<typeof listContainers>
}

/**
 * What the Django console API serves today: the session, the scope, the servers (list,
 * detail with its containers, history) and the container list. The rest is added here as the
 * backend gains it.
 */
export function createConsoleHttp(options: TransportOptions = {}): ConsoleHttp {
  const transport = createTransport(options)
  return {
    auth: createAuthClient(transport),
    getScopeOptions: getScopeOptions(transport),
    listServers: listServers(transport),
    getServer: getServer(transport),
    getServerSeries: getServerSeries(transport),
    getFleetLoad: getFleetLoad(transport),
    listContainers: listContainers(transport),
    listTargets: listTargets(transport),
    getTarget: getTarget(transport),
    getTargetSeries: getTargetSeries(transport),
    listDevices: listDevices(transport),
    getDevice: getDevice(transport),
    getDeviceSeries: getDeviceSeries(transport),
    getInterfaceSeries: getInterfaceSeries(transport),
  }
}

export { API_BASE } from './transport'
