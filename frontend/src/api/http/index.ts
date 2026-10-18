import type { AuthClient } from '../auth'
import type { SentinelApi } from '../client'
import type { ScopeOptions } from '../types'
import { listContainers } from './containers'
import { getDevice, getDeviceSeries, getInterfaceSeries, listDevices } from './devices'
import {
  createAlertRule,
  getAlertRule,
  getAlertRuleOptions,
  listAlertRules,
  updateAlertRule,
} from './alertRules'
import { acknowledgeIncident, getEngineStatus, getIncident, listIncidents } from './incidents'
import {
  getNotificationSettings,
  getTestEmail,
  requestTestEmail,
  saveNotificationPreferences,
} from './notifications'
import { getSystemStatus } from './system'
import { getTarget, getTargetSeries, listTargets } from './targets'
import { getTopology } from './topology'
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
  | 'getTopology'
  | 'listIncidents'
  | 'getIncident'
  | 'acknowledgeIncident'
  | 'getEngineStatus'
  | 'getNotificationSettings'
  | 'saveNotificationPreferences'
  | 'requestTestEmail'
  | 'getTestEmail'
  | 'listAlertRules'
  | 'getAlertRule'
  | 'getAlertRuleOptions'
  | 'createAlertRule'
  | 'updateAlertRule'
  | 'getSystemStatus'
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
    getTopology: getTopology(transport),
    listIncidents: listIncidents(transport),
    getIncident: getIncident(transport),
    acknowledgeIncident: acknowledgeIncident(transport),
    getEngineStatus: getEngineStatus(transport),
    getNotificationSettings: getNotificationSettings(transport),
    saveNotificationPreferences: saveNotificationPreferences(transport),
    requestTestEmail: requestTestEmail(transport),
    getTestEmail: getTestEmail(transport),
    listAlertRules: listAlertRules(transport),
    getAlertRule: getAlertRule(transport),
    getAlertRuleOptions: getAlertRuleOptions(transport),
    createAlertRule: createAlertRule(transport),
    updateAlertRule: updateAlertRule(transport),
    getSystemStatus: getSystemStatus(transport),
  }
}

export { API_BASE } from './transport'
