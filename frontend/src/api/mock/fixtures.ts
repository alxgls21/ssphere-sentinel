import type {
  ContainerHealth,
  ContainerState,
  Customer,
  DockerContainer,
  NetworkDevice,
  NetworkTarget,
  Scope,
  Server,
  Site,
} from '@/api/types'
import {
  LOSS_WARN_PERCENT,
  RESOURCE_CRIT_PERCENT,
  RESOURCE_WARN_PERCENT,
  resourceLevel,
  type ResourceLevel,
} from '@/lib/thresholds'
import {
  CUSTOMERS,
  DEVICE_SPECS,
  SERVER_SPECS,
  SIDECARS,
  SITES,
  TARGET_SPECS,
  type ContainerSpec,
  type ServerFault,
  type ServerSpec,
  type TargetSpec,
} from './estate'
import { clamp, createRng, hash01, hashString, round1, valueNoise } from './random'
import { conditionAt, latestProbeIndex, probeTime, type Episode, type ProbeModel } from './series'
import { HOUR, MINUTE, SECOND, toIso, type Clock } from './time'

export interface Fleet {
  customers: Customer[]
  sites: Site[]
  servers: Server[]
  containers: DockerContainer[]
  targets: NetworkTarget[]
  devices: NetworkDevice[]
}

/** The fleet plus the measurement models its network targets are probed by. */
export interface Estate {
  fleet: Fleet
  probes: ProbeModel[]
}

/**
 * What the estate looks like:
 *   story    the outage story (see estate.ts): every kind of problem at once
 *   calm     nothing wrong: the same fleet with no ongoing incident
 *   partial  calm, but a few things are not observed (never reported, no recent probe)
 *   empty    nothing is monitored
 */
export type FleetProfile = 'story' | 'calm' | 'partial' | 'empty'

const emptyEstate = (): Estate => ({
  fleet: { customers: [], sites: [], servers: [], containers: [], targets: [], devices: [] },
  probes: [],
})

/** A calm fleet keeps every resource below the warning threshold, with room for drift. */
const CALM_RESOURCE_CAP_PERCENT = 72
/** ...and every probe target answers quickly, however slow its link normally is. */
const CALM_LATENCY_CAP_MS = 90

/** Partial profile: targets nobody has measured. Minutes since the last probe; null = never probed. */
const PARTIAL_SILENT_TARGETS: Readonly<Record<string, number | null>> = {
  'core-git-https': null,
  'hc-portal': 180,
}
/** Partial profile: hosts whose Docker state the agent cannot read. */
const PARTIAL_DOCKER_UNAVAILABLE: ReadonlySet<string> = new Set(['muc-pos-02'])

/* ----------------------------------------------------------------- servers */

const AGENT_VERSION = '0.4.2'

function activeFault(spec: ServerSpec, profile: FleetProfile): ServerFault | undefined {
  if (profile === 'story') return spec.fault
  return profile === 'partial' && spec.fault?.kind === 'never' ? spec.fault : undefined
}

const LEVEL_BANDS: Record<ResourceLevel, readonly [low: number, high: number]> = {
  ok: [0, RESOURCE_WARN_PERCENT],
  warn: [RESOURCE_WARN_PERCENT, RESOURCE_CRIT_PERCENT],
  crit: [RESOURCE_CRIT_PERCENT, 100],
}

/**
 * A metric wandering slowly around its base, so repeated refreshes look
 * alive. It never leaves the base's threshold band: an entity's health is a
 * property of the scenario, not of the minute you happened to look.
 */
function drift(key: string, now: number, base: number, amplitude: number): number {
  const noise = valueNoise(hashString(key), now / (8 * MINUTE)) - 0.5
  const [low, high] = LEVEL_BANDS[resourceLevel(base)]
  return round1(clamp(base + noise * 2 * amplitude, low, high - 0.1))
}

function buildServer(spec: ServerSpec, profile: FleetProfile, { now, anchor }: Clock): Server {
  const fault = activeFault(spec, profile)
  const base = {
    id: `srv-${spec.name}`,
    name: spec.name,
    hostname: `${spec.name}.internal`,
    ipAddress: spec.ip,
    operatingSystem: spec.os,
    siteId: spec.site,
  }
  if (fault?.kind === 'never') {
    return { ...base, status: 'unknown', lastSeenAt: null, agentVersion: '', telemetry: null }
  }
  const cap = (value: number) =>
    profile === 'story' ? value : Math.min(value, CALM_RESOURCE_CAP_PERCENT)
  const memoryTotalBytes = spec.memGiB * 1024 ** 3
  const diskTotalBytes = spec.diskGiB * 1024 ** 3
  const baseUptime = spec.uptimeDays * 24 * 3600
  if (fault?.kind === 'offline') {
    // An offline host reports nothing new: its metrics stay frozen at the last heartbeat.
    const lastSeen = anchor - fault.lastSeenMin * MINUTE
    return {
      ...base,
      status: 'offline',
      lastSeenAt: toIso(lastSeen),
      agentVersion: AGENT_VERSION,
      telemetry: {
        cpuPercent: spec.cpu,
        memoryPercent: spec.mem,
        diskPercent: spec.disk,
        memoryTotalBytes,
        diskTotalBytes,
        uptimeSeconds: baseUptime,
        collectedAt: toIso(lastSeen),
      },
    }
  }
  // A fixed lag per host keeps hosts in the same order from one refresh to the next.
  const lastSeen = now - spec.seenAgoSec * SECOND
  return {
    ...base,
    status: 'online',
    lastSeenAt: toIso(lastSeen),
    agentVersion: AGENT_VERSION,
    telemetry: {
      cpuPercent: drift(`${spec.name}:cpu`, now, cap(spec.cpu), 4),
      memoryPercent: drift(`${spec.name}:mem`, now, cap(spec.mem), 1.5),
      diskPercent: drift(`${spec.name}:disk`, now, cap(spec.disk), 0.3),
      memoryTotalBytes,
      diskTotalBytes,
      uptimeSeconds: Math.floor(baseUptime + (now - anchor) / SECOND),
      collectedAt: toIso(lastSeen),
    },
  }
}

/** The hand-placed containers plus a seeded handful of exporters and agents. */
function containersOf(spec: ServerSpec): readonly ContainerSpec[] {
  const declared = spec.containers ?? []
  // Hosts that never report, or went dark, have nothing extra to show.
  if (declared.length === 0 || spec.fault) return declared
  const rng = createRng(`sidecars:${spec.name}`)
  const extra: ContainerSpec[] = []
  for (const [name, image, chance] of SIDECARS) {
    const drawn = rng() < chance
    if (drawn && !declared.some(([existing]) => existing === name))
      extra.push([name, image, 'none'])
  }
  return [...declared, ...extra]
}

function buildContainers(
  spec: ServerSpec,
  server: Server,
  profile: FleetProfile,
  { now, anchor }: Clock,
): DockerContainer[] {
  // Nothing can be observed on a host that went dark, or whose Docker socket is unreadable.
  const unobservable =
    server.status === 'offline' ||
    (profile === 'partial' && PARTIAL_DOCKER_UNAVAILABLE.has(spec.name))
  return containersOf(spec).map(
    ([name, image, declaredHealth = 'healthy', declaredState = 'running', upHours = 400]) => {
      const id = `ctr-${spec.name}-${name}`
      let state: ContainerState = declaredState
      let health: ContainerHealth = declaredHealth
      if (unobservable) {
        state = 'unknown'
        health = 'unknown'
      } else if (profile !== 'story') {
        if (state === 'dead' || state === 'restarting') state = 'running'
        if (health === 'unhealthy') health = 'healthy'
      }
      // A container that just (re)started is always "a few seconds ago", whatever the clock says.
      const justStarted = state === 'restarting' || health === 'starting'
      const startedAt =
        state === 'created'
          ? null
          : justStarted
            ? now - (10 + (hashString(id) % 40)) * SECOND
            : anchor - upHours * HOUR
      return {
        id,
        serverId: server.id,
        name,
        image,
        state,
        health: state === 'running' ? health : state === 'unknown' ? 'unknown' : 'none',
        startedAt: startedAt === null ? null : toIso(startedAt),
      }
    },
  )
}

/* ----------------------------------------------------------- network probes */

function buildProbeModel(spec: TargetSpec, profile: FleetProfile, { anchor }: Clock): ProbeModel {
  const story = profile === 'story'
  const intervalMs = (spec.intervalSec ?? 60) * SECOND
  const seed = hashString(spec.name)
  const baseJitter = spec.protocol === 'icmp' ? 0.1 : 0.15
  const loss = spec.lossPercent ?? 0
  const episodes: Episode[] = (spec.episodes ?? [])
    .filter((episode) => story || episode.toMin !== undefined)
    .map((episode) => ({
      from: anchor - episode.fromMin * MINUTE,
      to: episode.toMin === undefined ? null : anchor - episode.toMin * MINUTE,
      latencyMs: episode.latencyMs,
      lossPercent: episode.lossPercent,
      failure: episode.failure,
    }))
  return {
    targetId: `tgt-${spec.name}`,
    name: spec.name,
    protocol: spec.protocol,
    intervalMs,
    phaseMs: Math.floor(hash01(seed, 5) * (intervalMs / SECOND)) * SECOND,
    latencyMs: story ? spec.latencyMs : Math.min(spec.latencyMs, CALM_LATENCY_CAP_MS),
    jitter: baseJitter * (0.7 + 0.6 * hash01(seed, 11)),
    lossPercent: story || loss < LOSS_WARN_PERCENT ? loss : 0,
    flakyRate: story ? (spec.flaky ?? 0) : 0,
    silent: profile === 'partial' && spec.name in PARTIAL_SILENT_TARGETS,
    episodes,
  }
}

function buildTarget(
  spec: TargetSpec,
  model: ProbeModel,
  profile: FleetProfile,
  { now, anchor }: Clock,
): NetworkTarget {
  const identity = {
    id: model.targetId,
    name: spec.name,
    address: spec.address,
    protocol: spec.protocol,
    port: spec.port,
    siteId: spec.site,
  }
  if (model.silent) {
    const silentMin = PARTIAL_SILENT_TARGETS[spec.name]
    return {
      ...identity,
      status: 'unknown',
      latencyMs: null,
      packetLossPercent: 0,
      lastProbeAt: silentMin == null ? null : toIso(anchor - silentMin * MINUTE),
      failingSince: null,
      consecutiveFailures: 0,
      failureReason: '',
    }
  }
  const lastIndex = latestProbeIndex(model, now)
  const lastAt = probeTime(model, lastIndex)
  const failing = model.episodes.find(
    (episode) =>
      episode.failure !== undefined &&
      lastAt >= episode.from &&
      (episode.to === null || lastAt < episode.to),
  )
  const recent = profile === 'story' ? spec.recentFailures : undefined
  if (failing || recent) {
    // The run starts at the first probe after the link went dark; a flapping target's run is just its last probes.
    const firstIndex = failing
      ? Math.ceil((failing.from - model.phaseMs) / model.intervalMs)
      : lastIndex - (recent?.count ?? 1) + 1
    return {
      ...identity,
      status: 'down',
      latencyMs: null,
      packetLossPercent: 100,
      lastProbeAt: toIso(lastAt),
      failingSince: toIso(probeTime(model, firstIndex)),
      consecutiveFailures: lastIndex - firstIndex + 1,
      failureReason: failing?.failure ?? recent?.reason ?? 'timeout',
    }
  }
  const condition = conditionAt(model, now)
  const loss = model.protocol === 'icmp' ? round1(condition.lossPercent) : 0
  return {
    ...identity,
    status: loss >= LOSS_WARN_PERCENT ? 'degraded' : 'up',
    latencyMs: round1(condition.latencyMs),
    packetLossPercent: loss,
    lastProbeAt: toIso(lastAt),
    failingSince: null,
    consecutiveFailures: 0,
    failureReason: '',
  }
}

/* --------------------------------------------------------- network devices */

function buildDevices(profile: FleetProfile, { now }: Clock): NetworkDevice[] {
  return DEVICE_SPECS.map((spec) => {
    const calm = profile !== 'story'
    const reachable = calm || spec.reachable
    return {
      id: `dev-${spec.name}`,
      name: spec.name,
      deviceType: spec.type,
      managementAddress: spec.ip,
      siteId: spec.site,
      reachable,
      responseMs: reachable ? spec.responseMs : null,
      lastPollAt: toIso(now - spec.pollAgoSec * SECOND),
      interfacesTotal: spec.interfaces,
      interfacesDown: calm ? 0 : spec.down,
    }
  })
}

/* ------------------------------------------------------------------ estate */

export function buildEstate(profile: FleetProfile, clock: Clock): Estate {
  if (profile === 'empty') return emptyEstate()
  const servers: Server[] = []
  const containers: DockerContainer[] = []
  for (const spec of SERVER_SPECS) {
    const server = buildServer(spec, profile, clock)
    servers.push(server)
    containers.push(...buildContainers(spec, server, profile, clock))
  }
  const probes = TARGET_SPECS.map((spec) => buildProbeModel(spec, profile, clock))
  const targets = TARGET_SPECS.map((spec, index) =>
    buildTarget(spec, probes[index] as ProbeModel, profile, clock),
  )
  return {
    fleet: {
      customers: CUSTOMERS.map((customer) => ({ ...customer })),
      sites: SITES.map((site) => ({ ...site })),
      servers,
      containers,
      targets,
      devices: buildDevices(profile, clock),
    },
    probes,
  }
}

/**
 * Narrows the estate to a customer and/or site. Servers, targets and devices
 * carry a siteId; containers inherit their server's. Entities with no site
 * (public probes) belong to no scope but "everything". A customer and a site
 * that do not belong together select nothing.
 */
export function scopeEstate(estate: Estate, scope?: Scope): Estate {
  if (!scope || (scope.customerId === null && scope.siteId === null)) return estate
  const { fleet } = estate
  const sites = fleet.sites.filter(
    (site) =>
      (scope.customerId === null || site.customerId === scope.customerId) &&
      (scope.siteId === null || site.id === scope.siteId),
  )
  const siteIds = new Set(sites.map((site) => site.id))
  const inScope = (siteId: string | null) => siteId !== null && siteIds.has(siteId)
  const servers = fleet.servers.filter((server) => inScope(server.siteId))
  const serverIds = new Set(servers.map((server) => server.id))
  const targets = fleet.targets.filter((target) => inScope(target.siteId))
  const targetIds = new Set(targets.map((target) => target.id))
  return {
    fleet: {
      customers: fleet.customers.filter((customer) =>
        sites.some((site) => site.customerId === customer.id),
      ),
      sites,
      servers,
      containers: fleet.containers.filter((container) => serverIds.has(container.serverId)),
      targets,
      devices: fleet.devices.filter((device) => inScope(device.siteId)),
    },
    probes: estate.probes.filter((model) => targetIds.has(model.targetId)),
  }
}
