import type { AuthClient } from '../auth'
import type { SentinelApi } from '../client'
import type { ScopeOptions } from '../types'
import { listAgents } from './agents'
import { listAuditLog } from './audit'
import { listContainers } from './containers'
import {
  createCustomer,
  createSite,
  deleteCustomer,
  deleteSite,
  getCustomer,
  getSite,
  listCustomers,
  listSites,
  updateCustomer,
  updateSite,
} from './customers'
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
  createInventoryDevice,
  deleteInventoryDevice,
  getInventoryDevice,
  listInventoryDevices,
  updateInventoryDevice,
} from './inventory'
import {
  getNotificationSettings,
  getTestEmail,
  requestTestEmail,
  saveNotificationPreferences,
} from './notifications'
import { getSystemStatus } from './system'
import {
  createTarget,
  deleteTarget,
  getTarget,
  getTargetSeries,
  listTargets,
  updateTarget,
} from './targets'
import { getTopology } from './topology'
import { createAuthClient, getScopeOptions } from './session'
import {
  createAgent,
  createServer,
  deleteServer,
  getFleetLoad,
  getServer,
  getServerSeries,
  listServers,
  rotateAgentToken,
  setAgentEnabled,
  updateServer,
} from './servers'
import {
  changeOwnPassword,
  createUser,
  getUser,
  listUsers,
  resetUserPassword,
  unlockUser,
  updateUser,
} from './users'
import { createTransport, type TransportOptions } from './transport'

/** The console API, request by request. Every method validates its answer. */
export interface ConsoleHttp extends Pick<
  SentinelApi,
  | 'listServers'
  | 'getServer'
  | 'getServerSeries'
  | 'getFleetLoad'
  | 'createServer'
  | 'updateServer'
  | 'deleteServer'
  | 'createAgent'
  | 'rotateAgentToken'
  | 'setAgentEnabled'
  | 'listAgents'
  | 'listTargets'
  | 'getTarget'
  | 'getTargetSeries'
  | 'createTarget'
  | 'updateTarget'
  | 'deleteTarget'
  | 'listDevices'
  | 'getDevice'
  | 'getDeviceSeries'
  | 'getInterfaceSeries'
  | 'listInventoryDevices'
  | 'getInventoryDevice'
  | 'createInventoryDevice'
  | 'updateInventoryDevice'
  | 'deleteInventoryDevice'
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
  | 'listCustomers'
  | 'getCustomer'
  | 'createCustomer'
  | 'updateCustomer'
  | 'deleteCustomer'
  | 'listSites'
  | 'getSite'
  | 'createSite'
  | 'updateSite'
  | 'deleteSite'
  | 'listUsers'
  | 'getUser'
  | 'createUser'
  | 'updateUser'
  | 'resetUserPassword'
  | 'unlockUser'
  | 'changeOwnPassword'
  | 'listAuditLog'
> {
  auth: AuthClient
  getScopeOptions: (signal?: AbortSignal) => Promise<ScopeOptions>
  listContainers: ReturnType<typeof listContainers>
}

/**
 * What the Django console API serves: the session and the scope; the servers (adding one with its
 * agent and the agent's token, changing and deleting one), the agents, containers, network targets
 * (with their writes) and SNMP devices with their history; the inventory of devices and its writes;
 * the topology; the incidents and the alert engine; the notification settings, the alert rules and
 * the system status; customers and sites, accounts and the audit trail. A new endpoint is added here.
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
    createServer: createServer(transport),
    updateServer: updateServer(transport),
    deleteServer: deleteServer(transport),
    createAgent: createAgent(transport),
    rotateAgentToken: rotateAgentToken(transport),
    setAgentEnabled: setAgentEnabled(transport),
    listAgents: listAgents(transport),
    listContainers: listContainers(transport),
    listTargets: listTargets(transport),
    getTarget: getTarget(transport),
    getTargetSeries: getTargetSeries(transport),
    createTarget: createTarget(transport),
    updateTarget: updateTarget(transport),
    deleteTarget: deleteTarget(transport),
    listDevices: listDevices(transport),
    getDevice: getDevice(transport),
    getDeviceSeries: getDeviceSeries(transport),
    getInterfaceSeries: getInterfaceSeries(transport),
    listInventoryDevices: listInventoryDevices(transport),
    getInventoryDevice: getInventoryDevice(transport),
    createInventoryDevice: createInventoryDevice(transport),
    updateInventoryDevice: updateInventoryDevice(transport),
    deleteInventoryDevice: deleteInventoryDevice(transport),
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
    listCustomers: listCustomers(transport),
    getCustomer: getCustomer(transport),
    createCustomer: createCustomer(transport),
    updateCustomer: updateCustomer(transport),
    deleteCustomer: deleteCustomer(transport),
    listSites: listSites(transport),
    getSite: getSite(transport),
    createSite: createSite(transport),
    updateSite: updateSite(transport),
    deleteSite: deleteSite(transport),
    listUsers: listUsers(transport),
    getUser: getUser(transport),
    createUser: createUser(transport),
    updateUser: updateUser(transport),
    resetUserPassword: resetUserPassword(transport),
    unlockUser: unlockUser(transport),
    changeOwnPassword: changeOwnPassword(transport),
    listAuditLog: listAuditLog(transport),
  }
}

export { API_BASE } from './transport'
