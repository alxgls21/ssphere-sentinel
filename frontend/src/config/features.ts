/**
 * What the backend actually implements today, per feature. The UI uses this
 * to label mock data honestly: it must never imply a feature is operational
 * when it is not. Update an entry when the backend gains the capability.
 *
 * ingest      agent data is accepted and stored; the UI has no read API yet
 * partial     server side exists, but nothing produces data yet
 * admin-only  managed in the Django admin; the UI has no read API yet
 * planned     not implemented in the backend at all
 */
export type FeatureId =
  | 'servers'
  | 'docker'
  | 'network'
  | 'snmp'
  | 'topology'
  | 'alerts'
  | 'events'
  | 'customers'
  | 'site-links'

export type Readiness = 'ingest' | 'partial' | 'admin-only' | 'planned'

export interface FeatureInfo {
  id: FeatureId
  label: string
  readiness: Readiness
  /** One sentence an operator can read as-is. */
  note: string
}

export const FEATURES: Record<FeatureId, FeatureInfo> = {
  servers: {
    id: 'servers',
    label: 'Servers',
    readiness: 'ingest',
    note: 'Agent heartbeats are stored by the backend. Read APIs for the console are not available yet.',
  },
  docker: {
    id: 'docker',
    label: 'Docker',
    readiness: 'ingest',
    note: 'Docker reports are stored by the backend. Read APIs for the console are not available yet.',
  },
  network: {
    id: 'network',
    label: 'ICMP / TCP',
    readiness: 'ingest',
    note: 'Probe measurements are stored by the backend. Read APIs for the console are not available yet.',
  },
  snmp: {
    id: 'snmp',
    label: 'SNMP',
    readiness: 'partial',
    note: 'Server-side SNMP models exist, but the agent-side collector is not implemented: no device reports data yet.',
  },
  topology: {
    id: 'topology',
    label: 'Topology',
    readiness: 'planned',
    note: 'Topology and outage-impact analysis are not implemented in the backend.',
  },
  alerts: {
    id: 'alerts',
    label: 'Alerts',
    readiness: 'planned',
    note: 'The alert engine is not implemented in the backend. Alerts shown here are simulated.',
  },
  events: {
    id: 'events',
    label: 'Events',
    readiness: 'planned',
    note: 'The backend has no event log yet. Events shown here are simulated.',
  },
  'site-links': {
    id: 'site-links',
    label: 'Site assignment',
    readiness: 'planned',
    note: 'Servers and probe targets are not linked to sites in the backend (only SNMP devices are). Site grouping is sample data.',
  },
  customers: {
    id: 'customers',
    label: 'Customers & Sites',
    readiness: 'admin-only',
    note: 'Customers, sites and devices are managed in the Django admin. Read APIs for the console are not available yet.',
  },
}

/** True when the feature produces no real data today, so its panels need an explicit marker. */
export function isUnimplemented(id: FeatureId): boolean {
  const { readiness } = FEATURES[id]
  return readiness === 'planned' || readiness === 'partial'
}
