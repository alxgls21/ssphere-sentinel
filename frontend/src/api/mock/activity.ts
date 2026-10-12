import type {
  Alert,
  AlertSeverity,
  DockerContainer,
  EventLevel,
  NetworkDevice,
  NetworkTarget,
  SentinelEvent,
  Server,
  SubjectRef,
} from '@/api/types'
import { formatAge, formatLatency, formatPercent } from '@/lib/format'
import { deviceHealth } from '@/lib/status'
import {
  LATENCY_WARN_MS,
  LOSS_WARN_PERCENT,
  RESOURCE_CRIT_PERCENT,
  RESOURCE_WARN_PERCENT,
  resourceLevel,
} from '@/lib/thresholds'
import { worstResource } from './attention'
import type { Estate } from './fixtures'
import {
  containerHealthOf,
  makeLookup,
  serverHealthOf,
  targetHealthOf,
  type Lookup,
} from './lookup'
import { hashString } from './random'
import type { ProbeModel } from './series'
import { MINUTE, SECOND, toIso, type Clock } from './time'

/**
 * PLANNED features: the backend has no alert engine and no event log, so both
 * are sample data. They are derived from the same classified entities as every
 * other panel (an alert exists exactly where an entity is critical or
 * warning), and every timestamp is anchored to the story, so ids are stable
 * across polls and a console left open does not see old events as new.
 */

/** Default of the backend's SENTINEL_OFFLINE_THRESHOLD, seconds. */
const OFFLINE_THRESHOLD_SECONDS = 90

/** When each ongoing problem began, in minutes before the story anchor. Anything else gets a stable pseudo-random age. */
const SINCE_MIN: Readonly<Record<string, number>> = {
  'srv-ath-db-01': 128,
  'srv-hc-bkp-01': 47,
  'srv-fra-web-02': 23,
  'ctr-ath-db-01-pgbouncer': 72,
  'ctr-ath-app-01-api': 66,
  'ctr-fra-web-02-queue-worker': 23,
  'ctr-muc-pos-02-receipt-printer': 41,
  'tgt-muc-vpn': 3,
  'tgt-muc-cdn': 410,
  'tgt-hc-annex-lte': 1260,
  'dev-pir-sw1': 13,
  'dev-ath-core-sw1': 330,
  'dev-fra-core-sw1': 95,
  'dev-hc-core-sw1': 205,
}

/** Alerts somebody already looked at. */
const ACKNOWLEDGED: ReadonlySet<string> = new Set(['srv-hc-bkp-01'])

interface HistorySpec {
  id: string
  /** Minutes before the story anchor. */
  failMin: number
  recoverMin: number
  level: 'warning' | 'critical'
  failure: string
  recovery: string
}

/** Incidents of servers, containers and devices that already resolved (targets carry theirs as episodes). */
const HISTORY: readonly HistorySpec[] = [
  {
    id: 'srv-fra-cache-01',
    failMin: 118,
    recoverMin: 96,
    level: 'warning',
    failure: 'cpu 83%, above 80% limit',
    recovery: 'cpu back under 30%',
  },
  {
    id: 'srv-fra-web-01',
    failMin: 360,
    recoverMin: 331,
    level: 'warning',
    failure: 'cpu 88%, above 80% limit',
    recovery: 'cpu back under 70%',
  },
  {
    id: 'ctr-hc-pacs-01-orthanc',
    failMin: 1210,
    recoverMin: 1180,
    level: 'critical',
    failure: 'reported unhealthy',
    recovery: 'health check passing again',
  },
  {
    id: 'dev-fra-core-sw1',
    failMin: 733,
    recoverMin: 602,
    level: 'warning',
    failure: 'Gi1/0/24 utilization 92% for 10m',
    recovery: 'Gi1/0/24 utilization back under 80%',
  },
]

const INFO: readonly { id: string; min: number; message: string }[] = [
  { id: 'srv-fra-db-01', min: 262, message: 'pgbackrest container exited' },
  { id: 'srv-core-git-01', min: 415, message: 'agent updated 0.4.1 -> 0.4.2' },
  { id: 'srv-ath-app-02', min: 901, message: 'agent updated 0.4.1 -> 0.4.2' },
]

interface Finding {
  alert: Alert
  /** The line the event log shows when the problem began. */
  event: string
}

export interface Activity {
  alerts: Alert[]
  events: SentinelEvent[]
}

const ref = (kind: SubjectRef['kind'], id: string, name: string): SubjectRef => ({ kind, id, name })

const hex = (value: string) => hashString(value).toString(16).padStart(8, '0')

function subjectIndex(estate: Estate, lookup: Lookup): Map<string, SubjectRef> {
  const { fleet } = estate
  const subjects = new Map<string, SubjectRef>()
  for (const server of fleet.servers) subjects.set(server.id, ref('server', server.id, server.name))
  for (const container of fleet.containers) {
    subjects.set(container.id, containerRef(container, lookup))
  }
  for (const target of fleet.targets) subjects.set(target.id, ref('target', target.id, target.name))
  for (const device of fleet.devices) subjects.set(device.id, ref('device', device.id, device.name))
  for (const site of fleet.sites) subjects.set(site.id, ref('site', site.id, site.name))
  return subjects
}

const containerRef = (container: DockerContainer, lookup: Lookup): SubjectRef =>
  ref(
    'container',
    container.id,
    `${container.name}@${lookup.serverById.get(container.serverId)?.name ?? '?'}`,
  )

const sinceOf = (id: string, { anchor }: Clock): number =>
  anchor - (SINCE_MIN[id] ?? 20 + (hashString(id) % 240)) * MINUTE

/* ------------------------------------------------------------------ alerts */

function alertOf(
  rule: string,
  severity: AlertSeverity,
  title: string,
  message: string,
  subject: SubjectRef,
  siteId: string | null,
  since: number,
  event: string,
): Finding {
  return {
    alert: {
      id: `alr-${hex(`${rule}|${subject.id}`)}`,
      severity,
      state: ACKNOWLEDGED.has(subject.id) ? 'acknowledged' : 'active',
      title,
      message,
      subject,
      rule,
      siteId,
      since: toIso(since),
    },
    event,
  }
}

const severityOf = (health: 'critical' | 'warning'): AlertSeverity => health

function serverFinding(
  server: Server,
  health: 'critical' | 'warning',
  clock: Clock,
): Finding | null {
  const subject = ref('server', server.id, server.name)
  if (server.status === 'offline' && server.lastSeenAt !== null) {
    return alertOf(
      'server.heartbeat.missing',
      'critical',
      'Server offline',
      `No heartbeat for ${formatAge(server.lastSeenAt, clock.now)} (threshold ${OFFLINE_THRESHOLD_SECONDS}s)`,
      subject,
      server.siteId,
      Date.parse(server.lastSeenAt) + OFFLINE_THRESHOLD_SECONDS * SECOND,
      `marked offline: no heartbeat for ${OFFLINE_THRESHOLD_SECONDS}s`,
    )
  }
  const worst = worstResource(server)
  if (!worst) return null
  const limit =
    resourceLevel(worst.percent) === 'crit' ? RESOURCE_CRIT_PERCENT : RESOURCE_WARN_PERCENT
  const percent = formatPercent(worst.percent)
  return alertOf(
    `server.${worst.name}.high`,
    severityOf(health),
    `${worst.title} usage high`,
    `${percent} used (limit ${limit}%)`,
    subject,
    server.siteId,
    sinceOf(server.id, clock),
    `${worst.name} above ${limit}% limit`,
  )
}

function containerFinding(
  container: DockerContainer,
  health: 'critical' | 'warning',
  lookup: Lookup,
  clock: Clock,
): Finding | null {
  const host = lookup.serverById.get(container.serverId)
  const subject = containerRef(container, lookup)
  const since = sinceOf(container.id, clock)
  const on = host?.name ?? 'unknown host'
  const siteId = host?.siteId ?? null
  if (container.state === 'restarting') {
    return alertOf(
      'docker.container.restarting',
      severityOf(health),
      'Container restart loop',
      `Restarting repeatedly on ${on}`,
      subject,
      siteId,
      since,
      'entered restart loop',
    )
  }
  if (container.state === 'dead') {
    return alertOf(
      'docker.container.dead',
      severityOf(health),
      'Container dead',
      `Container is dead on ${on}`,
      subject,
      siteId,
      since,
      'reported dead',
    )
  }
  if (container.health === 'unhealthy') {
    return alertOf(
      'docker.container.unhealthy',
      severityOf(health),
      'Container unhealthy',
      `Health check failing on ${on}`,
      subject,
      siteId,
      since,
      'reported unhealthy',
    )
  }
  return null
}

const probeLabel = (target: NetworkTarget) =>
  `${target.protocol.toUpperCase()}${target.port === null ? '' : ` ${target.port}`}`

function targetFinding(
  target: NetworkTarget,
  health: 'critical' | 'warning',
  model: ProbeModel | undefined,
  clock: Clock,
): Finding | null {
  const subject = ref('target', target.id, target.name)
  const severity = severityOf(health)
  const ongoing = model?.episodes.find((episode) => episode.to === null)
  if (target.failingSince !== null) {
    const reason = (target.failureReason || 'probe failed').replaceAll('_', ' ')
    // A run that grew out of an episode began at its first failed probe; a flapping target's did not.
    const since =
      ongoing?.failure === undefined ? sinceOf(target.id, clock) : Date.parse(target.failingSince)
    return alertOf(
      'probe.failing',
      severity,
      'Probe failing',
      `${probeLabel(target)} ${reason}, ${target.consecutiveFailures} consecutive failures`,
      subject,
      target.siteId,
      since,
      `${probeLabel(target)} ${reason}, probes failing`,
    )
  }
  const since = ongoing ? ongoing.from : sinceOf(target.id, clock)
  if (target.packetLossPercent >= LOSS_WARN_PERCENT) {
    const loss = formatPercent(
      target.packetLossPercent,
      Number.isInteger(target.packetLossPercent) ? 0 : 1,
    )
    return alertOf(
      'probe.loss.high',
      severity,
      'Packet loss',
      `${loss} loss (limit ${LOSS_WARN_PERCENT}%)`,
      subject,
      target.siteId,
      since,
      `packet loss ${loss}`,
    )
  }
  if ((target.latencyMs ?? 0) > LATENCY_WARN_MS) {
    const latency = formatLatency(target.latencyMs)
    return alertOf(
      'probe.latency.high',
      severity,
      'Latency high',
      `${latency} (limit ${LATENCY_WARN_MS} ms)`,
      subject,
      target.siteId,
      since,
      `latency above ${LATENCY_WARN_MS} ms limit`,
    )
  }
  return null
}

function deviceFinding(device: NetworkDevice, clock: Clock): Finding | null {
  const health = deviceHealth(device.reachable, device.interfacesDown)
  const since = sinceOf(device.id, clock)
  if (health === 'critical') {
    return alertOf(
      'snmp.device.unreachable',
      'critical',
      'Device unreachable',
      'SNMP poll timeout, 3 consecutive polls',
      ref('device', device.id, device.name),
      device.siteId,
      since,
      'SNMP unreachable after 3 polls',
    )
  }
  if (health === 'warning') {
    const port = `Gi1/0/${1 + (hashString(device.id) % 24)}`
    const more = device.interfacesDown > 1 ? ` (+${device.interfacesDown - 1} more)` : ''
    return alertOf(
      'snmp.interface.down',
      'warning',
      'Interface down',
      `${port} admin up, oper down${more}`,
      ref(
        'interface',
        `${device.id}-${port.replaceAll('/', '-').toLowerCase()}`,
        `${port}@${device.name}`,
      ),
      device.siteId,
      since,
      `${port} oper status changed up -> down`,
    )
  }
  return null
}

/* ------------------------------------------------------------------ events */

/**
 * An event is history: it must keep its id (and so never look new) when the
 * live numbers in a message drift, so the id comes from when, who and how bad,
 * never from the wording.
 */
function makeEvent(
  at: number,
  level: EventLevel,
  subject: SubjectRef,
  message: string,
  parentId?: string,
): SentinelEvent {
  return {
    id: `evt-${hex(`${at}|${subject.id}|${level}`)}`,
    at: toIso(at),
    level,
    subject,
    message,
    ...(parentId ? { parentId } : {}),
  }
}

/** A failure and the recovery nested under it. */
function incident(
  subject: SubjectRef,
  failAt: number,
  recoverAt: number,
  level: 'warning' | 'critical',
  failure: string,
  recovery: string,
): SentinelEvent[] {
  const failed = makeEvent(failAt, level, subject, failure)
  return [failed, makeEvent(recoverAt, 'healthy', subject, recovery, failed.id)]
}

/** Resolved stretches of target misbehaviour: the same episodes the series charts. */
function targetIncidents(model: ProbeModel, target: NetworkTarget): SentinelEvent[] {
  const subject = ref('target', target.id, target.name)
  const events: SentinelEvent[] = []
  for (const episode of model.episodes) {
    if (episode.to === null) continue
    if (episode.failure !== undefined) {
      events.push(
        ...incident(
          subject,
          episode.from,
          episode.to,
          'critical',
          `${probeLabel(target)} ${episode.failure.replaceAll('_', ' ')}, probes failing`,
          'probes succeeding again',
        ),
      )
    } else {
      const failure =
        episode.lossPercent === undefined
          ? `latency ${formatLatency(episode.latencyMs)}, above ${LATENCY_WARN_MS} ms limit`
          : `packet loss ${formatPercent(episode.lossPercent)} over 5m`
      events.push(
        ...incident(
          subject,
          episode.from,
          episode.to,
          'warning',
          failure,
          `back to baseline (${formatLatency(model.latencyMs)})`,
        ),
      )
    }
  }
  return events
}

export function deriveActivity(estate: Estate, clock: Clock): Activity {
  const { fleet, probes } = estate
  const lookup = makeLookup(fleet)
  const subjects = subjectIndex(estate, lookup)
  const modelOf = new Map(probes.map((model) => [model.targetId, model]))

  const findings: Finding[] = []
  const add = (finding: Finding | null) => {
    if (finding) findings.push(finding)
  }
  for (const server of fleet.servers) {
    const health = serverHealthOf(server)
    if (health === 'critical' || health === 'warning') add(serverFinding(server, health, clock))
  }
  for (const container of fleet.containers) {
    const health = containerHealthOf(container)
    if (health === 'critical' || health === 'warning')
      add(containerFinding(container, health, lookup, clock))
  }
  for (const target of fleet.targets) {
    const health = targetHealthOf(target)
    if (health === 'critical' || health === 'warning')
      add(targetFinding(target, health, modelOf.get(target.id), clock))
  }
  for (const device of fleet.devices) add(deviceFinding(device, clock))

  const alerts = findings
    .map(({ alert }) => alert)
    .sort(
      (a, b) =>
        Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
        Date.parse(b.since) - Date.parse(a.since) ||
        a.id.localeCompare(b.id),
    )

  const events: SentinelEvent[] = []
  for (const { alert, event } of findings) {
    const began = makeEvent(Date.parse(alert.since), alert.severity, alert.subject, event)
    events.push(began)
    if (alert.state === 'acknowledged') {
      events.push(
        makeEvent(
          Date.parse(alert.since) + 5 * MINUTE,
          'info',
          alert.subject,
          'alert acknowledged by ops',
          began.id,
        ),
      )
    }
  }
  for (const target of fleet.targets) {
    const model = modelOf.get(target.id)
    if (model) events.push(...targetIncidents(model, target))
  }
  for (const spec of HISTORY) {
    const subject = subjects.get(spec.id)
    if (!subject) continue
    events.push(
      ...incident(
        subject,
        clock.anchor - spec.failMin * MINUTE,
        clock.anchor - spec.recoverMin * MINUTE,
        spec.level,
        spec.failure,
        spec.recovery,
      ),
    )
  }
  for (const { id, min, message } of INFO) {
    const subject = subjects.get(id)
    if (subject) events.push(makeEvent(clock.anchor - min * MINUTE, 'info', subject, message))
  }
  for (const server of fleet.servers) {
    if (server.status === 'unknown') {
      events.push(
        makeEvent(
          clock.anchor - 150 * MINUTE,
          'info',
          ref('server', server.id, server.name),
          'enrolled, waiting for first heartbeat',
        ),
      )
    }
  }
  // When several targets of one site fail together, the last good probe marks where the outage began.
  for (const site of fleet.sites) {
    const failures = fleet.targets.flatMap((target) =>
      target.siteId === site.id && targetHealthOf(target) === 'critical' && target.failingSince
        ? [Date.parse(target.failingSince)]
        : [],
    )
    if (failures.length < 2) continue
    const firstFailure = Math.min(...failures)
    events.push(
      makeEvent(
        firstFailure - MINUTE,
        'info',
        ref('site', site.id, site.name),
        'last successful probe before connectivity loss',
      ),
    )
  }

  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
  return { alerts, events }
}
