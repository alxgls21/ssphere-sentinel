import type { SentinelApi } from '../client'
import type {
  AgentChange,
  AgentEnrollment,
  AgentInput,
  ContainerHealth,
  ContainerState,
  FleetLoad,
  FleetLoadOptions,
  MonitoringAgent,
  Server,
  ServerContainer,
  ServerDetail,
  ServerInput,
  ServerList,
  ServerListItem,
  ServerListOptions,
  ServerSeries,
  ServerSeriesOptions,
  ServerStatus,
  ServerTelemetry,
} from '../types'
import { listQuery, parseCounts, parseStandardList } from './lists'
import {
  HEALTH,
  array,
  bad,
  flag,
  nullableNumber,
  nullableText,
  nullableTime,
  number,
  oneOf,
  parallel,
  record,
  text,
  time,
  whole,
} from './parse'
import type { Transport } from './transport'

/**
 * The console API's servers: the list (`servers/`), one server with its agent and its containers
 * (`servers/<id>/`), a server's history (`servers/<id>/series/`), and the writes that add a
 * monitored host: a server (POST `servers/`), its agent (POST `servers/<id>/agents/`, answered
 * with the token once), a new token (POST `agents/<id>/rotate-token/`) and the agent's enabled
 * flag (PATCH `agents/<id>/`). Every answer is validated and mapped onto the view-models of
 * api/types; one that does not fit is a `bad_response` error, never a guess. What a write
 * carries is named field by field: nothing else the caller holds can go out.
 */

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

export function parseServerList(raw: unknown): ServerList {
  return parseStandardList(raw, parseItem)
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

/** The agent of a server: its identity and state. A token or a hash, were one ever sent, is not read. */
export function parseAgent(raw: unknown): MonitoringAgent {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    enabled: flag(row.enabled),
    lastSeenAt: nullableTime(row.lastSeenAt),
    agentVersion: text(row.agentVersion),
    createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt),
  }
}

export function parseServerDetail(raw: unknown): ServerDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseItem(row.item),
    agent: row.agent === null ? null : parseAgent(row.agent),
    containers: array(row.containers).map(parseContainer),
  }
}

/**
 * The one answer that carries a plaintext token. The token is read as text and handed on, nothing
 * more; the address is null while the server has none to give (no `SENTINEL_URL`).
 */
export function parseAgentEnrollment(raw: unknown): AgentEnrollment {
  const row = record(raw)
  const token = text(row.token)
  const serverUrl = nullableText(row.serverUrl)
  if (token === '' || serverUrl === '') throw bad()
  return { generatedAt: time(row.generatedAt), item: parseAgent(row.item), token, serverUrl }
}

export function parseAgentChange(raw: unknown): AgentChange {
  const row = record(raw)
  return { generatedAt: time(row.generatedAt), item: parseAgent(row.item) }
}

export function parseServerSeries(raw: unknown): ServerSeries {
  const row = record(raw)
  const t = array(row.t).map(number)
  const column = parallel(t)
  return {
    generatedAt: time(row.generatedAt),
    bucketMs: number(row.bucketMs),
    t,
    cpu: column(row.cpu, nullableNumber),
    memory: column(row.memory, nullableNumber),
    disk: column(row.disk, nullableNumber),
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
    parseServerDetail(await transport.get(serverPath(id), { signal: options.signal }))

export const getServerSeries =
  (transport: Transport) =>
  async ({ serverId, range, signal }: ServerSeriesOptions): Promise<ServerSeries> =>
    parseServerSeries(
      await transport.get(`servers/${encodeURIComponent(serverId)}/series/`, {
        signal,
        query: { range },
      }),
    )

/** A server or agent id is a path segment: it is encoded, never trusted. */
const serverPath = (id: string) => `servers/${encodeURIComponent(id)}/`
const agentPath = (id: string) => `agents/${encodeURIComponent(id)}/`

/**
 * The body of a new server, field by field: a field left out stays out (the server's default),
 * `null` is sent only for what means "none" (no address, no site), and a blank hostname is left
 * to the server, which names the host by its name.
 */
function serverBody(input: ServerInput): Record<string, unknown> {
  const out: Record<string, unknown> = { name: input.name }
  const set = (name: string, value: unknown) => {
    if (value !== undefined) out[name] = value
  }
  set('hostname', input.hostname)
  set('description', input.description)
  set('operatingSystem', input.operatingSystem)
  set('ipAddress', input.ipAddress)
  set('siteId', input.siteId)
  return out
}

export const createServer =
  (transport: Transport): SentinelApi['createServer'] =>
  async (input, options) =>
    parseServerDetail(
      await transport.post('servers/', serverBody(input), { signal: options?.signal }),
    )

/** An agent's name, and nothing else: the token is the server's to make. */
export const createAgent =
  (transport: Transport): SentinelApi['createAgent'] =>
  async (serverId, input: AgentInput, options) =>
    parseAgentEnrollment(
      await transport.post(
        `${serverPath(serverId)}agents/`,
        input.name === undefined ? {} : { name: input.name },
        { signal: options?.signal },
      ),
    )

export const rotateAgentToken =
  (transport: Transport): SentinelApi['rotateAgentToken'] =>
  async (agentId, options) =>
    parseAgentEnrollment(
      await transport.post(`${agentPath(agentId)}rotate-token/`, {}, { signal: options?.signal }),
    )

export const setAgentEnabled =
  (transport: Transport): SentinelApi['setAgentEnabled'] =>
  async (agentId, enabled, options) =>
    parseAgentChange(
      await transport.patch(agentPath(agentId), { enabled }, { signal: options?.signal }),
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
