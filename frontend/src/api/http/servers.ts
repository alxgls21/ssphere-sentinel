import type {
  ContainerHealth,
  ContainerState,
  FleetLoad,
  FleetLoadOptions,
  HealthStatus,
  PageInfo,
  Server,
  ServerContainer,
  ServerDetail,
  ServerList,
  ServerListItem,
  ServerListOptions,
  ServerSeries,
  ServerSeriesOptions,
  ServerStatus,
  ServerTelemetry,
  StatusCounts,
} from '../types'
import {
  array,
  bad,
  flag,
  nullableText,
  nullableTime,
  number,
  oneOf,
  record,
  text,
  time,
  whole,
} from './parse'
import type { Transport } from './transport'

/**
 * The console API's servers: the list (`servers/`), one server with its containers
 * (`servers/<id>/`) and a server's history (`servers/<id>/series/`). Every answer is
 * validated and mapped onto the view-models of api/types; one that does not fit is a
 * `bad_response` error, never a guess.
 */

const HEALTH: readonly HealthStatus[] = ['healthy', 'warning', 'critical', 'unknown', 'idle']
const SERVER_STATUS: readonly ServerStatus[] = ['online', 'offline', 'warning', 'unknown']
const CONTAINER_STATE: readonly ContainerState[] = [
  'running',
  'exited',
  'paused',
  'restarting',
  'created',
  'dead',
  'unknown',
]
const CONTAINER_HEALTH: readonly ContainerHealth[] = [
  'healthy',
  'unhealthy',
  'starting',
  'none',
  'unknown',
]

export function parseCounts(raw: unknown): StatusCounts {
  const row = record(raw)
  const count = (key: HealthStatus) => whole(row[key])
  return {
    healthy: count('healthy'),
    warning: count('warning'),
    critical: count('critical'),
    unknown: count('unknown'),
    idle: count('idle'),
  }
}

function parseTelemetry(raw: unknown): ServerTelemetry | null {
  if (raw === null) return null
  const row = record(raw)
  return {
    cpuPercent: number(row.cpuPercent),
    memoryPercent: number(row.memoryPercent),
    diskPercent: number(row.diskPercent),
    memoryTotalBytes: number(row.memoryTotalBytes),
    diskTotalBytes: number(row.diskTotalBytes),
    uptimeSeconds: number(row.uptimeSeconds),
    collectedAt: time(row.collectedAt),
    receivedAt: time(row.receivedAt),
    stale: flag(row.stale),
  }
}

function parseServer(raw: unknown): Server {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    hostname: text(row.hostname),
    ipAddress: nullableText(row.ipAddress),
    operatingSystem: text(row.operatingSystem),
    status: oneOf(SERVER_STATUS, row.status),
    siteId: nullableText(row.siteId),
    lastSeenAt: nullableTime(row.lastSeenAt),
    agentVersion: text(row.agentVersion),
    telemetry: parseTelemetry(row.telemetry),
  }
}

function parseItem(raw: unknown): ServerListItem {
  const row = record(raw)
  const containers = record(row.containers)
  return {
    server: parseServer(row.server),
    health: oneOf(HEALTH, row.health),
    ...(row.customerName === undefined ? {} : { customerName: text(row.customerName) }),
    ...(row.siteName === undefined ? {} : { siteName: text(row.siteName) }),
    containers: { total: whole(containers.total), counts: parseCounts(containers.counts) },
  }
}

export function parsePage(raw: unknown): PageInfo {
  const row = record(raw)
  return {
    number: whole(row.number, 1),
    size: whole(row.size, 1),
    total: whole(row.total),
    pages: whole(row.pages, 1),
  }
}

export function parseServerList(raw: unknown): ServerList {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseItem),
    page: parsePage(row.page),
    counts: parseCounts(row.counts),
    scopeTotal: whole(row.scopeTotal),
  }
}

export function parseContainer(raw: unknown): ServerContainer {
  const row = record(raw)
  const container = record(row.container)
  return {
    container: {
      id: text(container.id),
      serverId: text(container.serverId),
      name: text(container.name),
      image: text(container.image),
      state: oneOf(CONTAINER_STATE, container.state),
      health: oneOf(CONTAINER_HEALTH, container.health),
      startedAt: nullableTime(container.startedAt),
    },
    status: oneOf(HEALTH, row.status),
  }
}

export function parseServerDetail(raw: unknown): ServerDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseItem(row.item),
    containers: array(row.containers).map(parseContainer),
  }
}

export function parseServerSeries(raw: unknown): ServerSeries {
  const row = record(raw)
  const t = array(row.t).map(number)
  const metric = (value: unknown): (number | null)[] => {
    const values = array(value).map((sample) => (sample === null ? null : number(sample)))
    if (values.length !== t.length) throw bad()
    return values
  }
  return {
    generatedAt: time(row.generatedAt),
    bucketMs: number(row.bucketMs),
    t,
    cpu: metric(row.cpu),
    memory: metric(row.memory),
    disk: metric(row.disk),
  }
}

/** The query string of a list request: what is left at its default is not sent. */
function listQuery(options: ServerListOptions): Record<string, string | undefined> {
  const q = options.q?.trim()
  return {
    customer: options.scope?.customerId ?? undefined,
    site: options.scope?.siteId ?? undefined,
    q: q ? q : undefined,
    status: options.status && options.status !== 'all' ? options.status : undefined,
    sort: options.sort,
    dir: options.dir,
    page: options.page === undefined ? undefined : String(options.page),
    pageSize: options.pageSize === undefined ? undefined : String(options.pageSize),
  }
}

export const listServers =
  (transport: Transport) =>
  async (options: ServerListOptions = {}): Promise<ServerList> =>
    parseServerList(
      await transport.get('servers/', { signal: options.signal, query: listQuery(options) }),
    )

export const getServer =
  (transport: Transport) =>
  async (id: string, options: { signal?: AbortSignal } = {}): Promise<ServerDetail> =>
    parseServerDetail(
      await transport.get(`servers/${encodeURIComponent(id)}/`, { signal: options.signal }),
    )

export const getServerSeries =
  (transport: Transport) =>
  async ({ serverId, range, signal }: ServerSeriesOptions): Promise<ServerSeries> =>
    parseServerSeries(
      await transport.get(`servers/${encodeURIComponent(serverId)}/series/`, {
        signal,
        query: { range },
      }),
    )

const LOAD_SORT = { cpu: 'cpu', memory: 'memory', disk: 'disk' } as const
const LOAD_FIELD = { cpu: 'cpuPercent', memory: 'memoryPercent', disk: 'diskPercent' } as const
const DEFAULT_LOAD_LIMIT = 8

/**
 * The busiest servers by one resource, from the list endpoint's own ordering: it ranks only
 * current readings and puts the rest last, so a stale reading never ranks and never shows as a
 * load. Servers without a current reading that fall inside the window are named as excluded;
 * the endpoint does not count the ones beyond it.
 */
export const getFleetLoad =
  (transport: Transport) =>
  async ({ metric, limit, scope, signal }: FleetLoadOptions): Promise<FleetLoad> => {
    const wanted = limit ?? DEFAULT_LOAD_LIMIT
    const list = await listServers(transport)({
      scope,
      signal,
      sort: LOAD_SORT[metric],
      dir: 'desc',
      page: 1,
      pageSize: wanted,
    })
    const rows: FleetLoad['rows'] = []
    const excluded: string[] = []
    for (const { server } of list.items) {
      const reading = server.telemetry
      const current =
        reading !== null &&
        reading.stale === false &&
        (server.status === 'online' || server.status === 'warning')
      if (!current) excluded.push(server.name)
      else {
        rows.push({
          serverId: server.id,
          name: server.name,
          percent: reading[LOAD_FIELD[metric]],
          collectedAt: reading.collectedAt,
        })
      }
    }
    return {
      generatedAt: list.generatedAt,
      rows,
      excluded: excluded.toSorted((a, b) => a.localeCompare(b)),
    }
  }
