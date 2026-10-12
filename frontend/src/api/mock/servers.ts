import { ApiError } from '../errors'
import type {
  RangeKey,
  Server,
  ServerDetail,
  ServerList,
  ServerListItem,
  ServerSeries,
} from '../types'
import { countStatuses } from '@/lib/status'
import type { Fleet } from './fixtures'
import { containerHealthOf, makeLookup, serverHealthOf, type Lookup } from './lookup'
import { clamp, hash01, hashString, round1, valueNoise } from './random'
import { BUCKET_MS, RANGE_MS } from './series'
import { DAY, MINUTE, toIso } from './time'

/**
 * The Servers screen's data, derived from the same fleet as the Overview, so a
 * server reads the same on both: same status, same numbers, same containers.
 */

function itemOf(server: Server, fleet: Fleet, lookup: Lookup): ServerListItem {
  const place = lookup.placeOfSite(server.siteId)
  const containers = fleet.containers.filter((container) => container.serverId === server.id)
  return {
    server,
    health: serverHealthOf(server),
    ...(place.customerName ? { customerName: place.customerName } : {}),
    ...(place.siteName ? { siteName: place.siteName } : {}),
    containers: {
      total: containers.length,
      counts: countStatuses(containers.map(containerHealthOf)),
    },
  }
}

export function listServers(fleet: Fleet, now: number): ServerList {
  const lookup = makeLookup(fleet)
  return {
    generatedAt: toIso(now),
    items: fleet.servers.map((server) => itemOf(server, fleet, lookup)),
  }
}

export function serverDetail(fleet: Fleet, id: string, now: number): ServerDetail {
  const server = fleet.servers.find((candidate) => candidate.id === id)
  if (!server) throw new ApiError(`Server ${id} not found`, 404)
  return {
    generatedAt: toIso(now),
    item: itemOf(server, fleet, makeLookup(fleet)),
    containers: fleet.containers
      .filter((container) => container.serverId === id)
      .map((container) => ({ container, status: containerHealthOf(container) })),
  }
}

/** Samples this close to "now" are pulled onto the server's actual latest reading, so the chart ends where the list says. */
const SETTLE_MS = 10 * MINUTE

type Metric = 'cpu' | 'memory' | 'disk'

const WANDER: Record<Metric, { relative: number; periodMin: number }> = {
  cpu: { relative: 0.35, periodMin: 6 },
  memory: { relative: 0.06, periodMin: 90 },
  disk: { relative: 0, periodMin: 1 },
}

/** Disk only grows: points per day, a little different on every host. */
const diskGrowthPerDay = (name: string) => 0.2 + 1.3 * hash01(hashString(name), 77)

function sampleAt(server: Server, metric: Metric, latest: number, t: number, end: number): number {
  const seed = hashString(`${server.name}:${metric}`)
  let value: number
  if (metric === 'disk') {
    value = latest - (diskGrowthPerDay(server.name) * (end - t)) / DAY
  } else {
    const { relative, periodMin } = WANDER[metric]
    const noise = valueNoise(seed, t / (periodMin * MINUTE)) - 0.5
    value = latest * (1 + noise * 2 * relative)
    const weight = clamp(1 - (end - t) / SETTLE_MS, 0, 1)
    value = value * (1 - weight) + latest * weight
  }
  return round1(clamp(value, 0, 100))
}

/**
 * History behind the latest reading. An offline host's history stops at its
 * last heartbeat (nulls after it); one that never reported has none at all.
 */
export function buildServerSeries(server: Server, range: RangeKey, now: number): ServerSeries {
  const bucketMs = BUCKET_MS[range]
  const series: ServerSeries = {
    generatedAt: toIso(now),
    bucketMs,
    t: [],
    cpu: [],
    memory: [],
    disk: [],
  }
  const telemetry = server.telemetry
  if (!telemetry || !server.lastSeenAt) return series

  const lastSample = Date.parse(server.lastSeenAt)
  const count = RANGE_MS[range] / bucketMs
  const end = Math.floor(now / bucketMs) * bucketMs
  for (let i = count; i >= 1; i -= 1) {
    const start = end - i * bucketMs
    const observed = start <= lastSample
    series.t.push(start)
    series.cpu.push(
      observed ? sampleAt(server, 'cpu', telemetry.cpuPercent, start, lastSample) : null,
    )
    series.memory.push(
      observed ? sampleAt(server, 'memory', telemetry.memoryPercent, start, lastSample) : null,
    )
    series.disk.push(
      observed ? sampleAt(server, 'disk', telemetry.diskPercent, start, lastSample) : null,
    )
  }
  return series
}
