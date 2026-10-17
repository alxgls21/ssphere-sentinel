/**
 * What each feature is, in the backend and in the console, so the UI never says
 * more or less than is true. Four facts are kept apart, and none implies another:
 *
 *   backend        what the backend offers
 *     console-api    the console API serves it
 *     stored         the backend stores it, but the console API does not serve it
 *     unsupported    the backend does not implement it
 *     unknown        not known
 *   connected      the console reads it from the backend. False while a screen
 *                  still shows demo data, even where the backend is ready.
 *   requires       what an operator must set up for the backend to have data. This
 *                  is information: it says nothing about whether that was done.
 *   configuration  whether that setup is done, only from reliable evidence (a
 *                  capability the backend reports). Never inferred from `requires`,
 *                  and `unknown` (the default) is not "missing".
 *
 * Update an entry when the backend or the console changes; every marker follows.
 */

export type FeatureId =
  | 'overview'
  | 'servers'
  | 'docker'
  | 'network'
  | 'network-overview'
  | 'snmp'
  | 'topology'
  | 'alerts'
  | 'events'
  | 'customers'
  | 'site-links'

export type Backend = 'console-api' | 'stored' | 'unsupported' | 'unknown'
export type Configuration = 'complete' | 'missing' | 'unknown'
export type DataSource = 'mock' | 'http'

/**
 *   live                 the console API serves it, the screen reads it, real data
 *   not-connected        not live: the console API does not serve it, or the screen
 *                        does not read it yet, or the data is demo data
 *   needs-configuration  otherwise live, but its setup is confirmed missing
 *   planned              the backend does not implement it
 *   unknown              not known
 */
export type Availability = 'live' | 'not-connected' | 'needs-configuration' | 'planned' | 'unknown'

export interface FeatureInfo {
  id: FeatureId
  label: string
  backend: Backend
  connected: boolean
  /** What must be set up for the backend to have data, as a phrase. Information, not a status. */
  requires?: string
  /** Confirmed state of that setup. Absent means unknown. */
  configuration?: Configuration
  /** Its panels show an empty placeholder (dashed) rather than demo figures while it is not connected. */
  placeholder?: boolean
  /** One sentence an operator can read as-is. */
  note: string
}

export const FEATURES: Record<FeatureId, FeatureInfo> = {
  overview: {
    id: 'overview',
    label: 'Overview summary',
    backend: 'console-api',
    connected: true,
    note: 'The console API counts servers, containers, probe targets and SNMP devices, and the overview tiles, verdict, attention queue and health breakdown read those counts. It counts nothing else.',
  },
  servers: {
    id: 'servers',
    label: 'Servers',
    backend: 'console-api',
    connected: true,
    note: 'The console API serves servers, their latest telemetry and its history, and these screens read them.',
  },
  docker: {
    id: 'docker',
    label: 'Docker',
    backend: 'console-api',
    connected: true,
    note: 'The console API serves containers with their server, their state and their health, and the Docker screen reads them.',
  },
  network: {
    id: 'network',
    label: 'ICMP / TCP',
    backend: 'console-api',
    connected: true,
    note: 'The console API serves probe targets, their measurements and their history, and the Network screens read them.',
  },
  'network-overview': {
    id: 'network-overview',
    label: 'Fleet latency on the Overview',
    backend: 'stored',
    connected: false,
    placeholder: true,
    note: 'The console API serves each target and its history, but no fleet-wide latency aggregation, so the Overview draws no latency chart.',
  },
  snmp: {
    id: 'snmp',
    label: 'SNMP',
    backend: 'console-api',
    connected: true,
    requires:
      'an agent installed with the SNMP extra, a device with its SNMP settings and a credentials file on the agent host',
    note: 'The console API serves SNMP devices, their polls and interfaces; the SNMP screens and the Overview read them.',
  },
  topology: {
    id: 'topology',
    label: 'Topology',
    backend: 'console-api',
    connected: true,
    note: 'The console API serves what is recorded: which customer and site holds what, what runs on which server and which agent monitors which target or device. It knows no cabling or routing, so the map draws no physical links and works out no outage impact.',
  },
  alerts: {
    id: 'alerts',
    label: 'Alerts',
    backend: 'console-api',
    connected: true,
    requires: 'the alert engine running, and at least one enabled alert rule',
    note: 'The console API serves the incidents the alert engine opens and the engine’s own state; the Alerts screen, the topbar indicator and the Overview read them. Incidents are acknowledged here and end when the engine confirms a recovery.',
  },
  events: {
    id: 'events',
    label: 'Events',
    backend: 'unsupported',
    connected: false,
    note: 'The backend has no event log yet, so there are no events to show.',
  },
  'site-links': {
    id: 'site-links',
    label: 'Site assignment',
    backend: 'console-api',
    connected: true,
    requires: 'placing each server and probe target on a site in the admin',
    note: 'The backend supports placing servers and probe targets on a site, and the console API filters by it. A server with no site is shown on none.',
  },
  customers: {
    id: 'customers',
    label: 'Customers & Sites',
    backend: 'console-api',
    connected: false,
    note: 'The console API lists the customers and sites you may see (the scope selector uses it). They are managed in the Django admin; this screen is not built yet.',
  },
}

/**
 * What a feature is right now. It is `live` only when everything needed for real
 * data is present: the console API serves it, the console reads it, and the data
 * is not demo data. Anything short of that, or unknown, is never `live`.
 *
 * `source` is where the data comes from; without it the data is not assumed real.
 * Required setup is not consulted: `needs-configuration` needs confirmed evidence
 * that setup is missing, and only means something once the rest is in place.
 */
export function availabilityOf(id: FeatureId, source?: DataSource): Availability {
  const feature = FEATURES[id] as FeatureInfo | undefined
  if (!feature || feature.backend === 'unknown') return 'unknown'
  if (feature.backend === 'unsupported') return 'planned'
  if (feature.backend !== 'console-api' || !feature.connected || source !== 'http') {
    return 'not-connected'
  }
  return feature.configuration === 'missing' ? 'needs-configuration' : 'live'
}

/** The backend does not implement it: PLANNED. */
export const isPlanned = (id: FeatureId): boolean => availabilityOf(id) === 'planned'

/**
 * Nothing real is shown for it, and its panels say so with a dashed frame: not
 * implemented, confirmed unconfigured, or not connected and showing only an empty
 * placeholder (not demo figures).
 */
export function isPlaceholder(id: FeatureId, source?: DataSource): boolean {
  const availability = availabilityOf(id, source)
  return (
    availability === 'planned' ||
    availability === 'needs-configuration' ||
    (availability === 'not-connected' && FEATURES[id].placeholder === true)
  )
}

/** Where a feature falls short of live, or null once it is: what a chip should say. */
export function shortfallOf(
  id: FeatureId,
  source?: DataSource,
): Exclude<Availability, 'live'> | null {
  const availability = availabilityOf(id, source)
  return availability === 'live' ? null : availability
}

/** The chip word for an availability that needs one. */
export const AVAILABILITY_WORD: Record<Exclude<Availability, 'live'>, string> = {
  planned: 'Planned',
  'needs-configuration': 'Needs setup',
  'not-connected': 'Not connected',
  unknown: 'Unknown',
}

/** Shorter words for a header with little room (a tile). The tooltip and spoken text carry the rest. */
export const AVAILABILITY_WORD_SHORT: Record<Exclude<Availability, 'live'>, string> = {
  planned: 'Planned',
  'needs-configuration': 'Setup',
  'not-connected': 'Demo',
  unknown: 'Unknown',
}

/** One line on where a feature stands, for headings and spoken labels. */
export function describeAvailability(id: FeatureId, source?: DataSource): string {
  const feature = FEATURES[id] as FeatureInfo | undefined
  switch (availabilityOf(id, source)) {
    case 'live':
      return 'Connected to the console API'
    case 'planned':
      return 'Not implemented in the backend'
    case 'unknown':
      return 'Not detected: this console cannot tell what the backend supports'
    case 'needs-configuration':
      return 'Connected to the console API, but its setup is missing'
    case 'not-connected':
      return feature?.backend === 'console-api'
        ? 'Served by the console API; this screen is not connected to it yet'
        : 'Stored by the backend; the console API does not serve it yet'
  }
}

/**
 * What rendered content may say about where it comes from. One rule, used by
 * every component that shows provenance (visually and to assistive technology):
 *
 *   live     every feature behind it is `live`: served by the console API, read by
 *            the screen, real data (this implies an HTTP source)
 *   mock     demo or simulated figures, or any mix that includes them
 *   unknown  nothing can be verified: no source, no feature to judge it by, or only
 *            features whose state is unknown
 *
 * The adapter-wide source is never enough: an HTTP adapter says nothing about
 * whether this feature's figures are real. Anything not provably live is not live.
 */
export type Provenance = 'live' | 'mock' | 'unknown'

export function provenanceOf(ids: readonly FeatureId[], source?: DataSource): Provenance {
  if (ids.length === 0 || (source !== 'http' && source !== 'mock')) return 'unknown'
  const states = ids.map((id) => availabilityOf(id, source))
  if (states.every((state) => state === 'live')) return 'live'
  // Demo, simulated or stored-only figures are what is on screen.
  if (states.some((state) => state === 'not-connected' || state === 'planned')) return 'mock'
  return 'unknown'
}

/** The words an assistive technology hears for a provenance, or null when it is live and nothing needs saying. */
export const PROVENANCE_SPOKEN: Record<Provenance, string | null> = {
  live: null,
  mock: 'mock data',
  unknown: 'source not verified',
}

/** The feature whose data an entity of this kind is. */
export const FEATURE_OF_ENTITY: Record<'server' | 'container' | 'target' | 'device', FeatureId> = {
  server: 'servers',
  // The containers an entity cell shows are the overview's counts (the Docker screen reads its own list).
  container: 'overview',
  target: 'network',
  device: 'snmp',
}

/**
 * The features whose figures the screens show. While any is not live, the app as a whole shows demo
 * data. Events are not in the list: no screen shows a figure for them, only a statement that they
 * are not available.
 */
export const DATA_FEATURES: readonly FeatureId[] = [
  'overview',
  'servers',
  'docker',
  'network',
  'snmp',
  'topology',
  'alerts',
  'site-links',
]
