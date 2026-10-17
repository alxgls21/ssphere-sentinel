import { describe, expect, it } from 'vitest'
import type {
  ContainerList,
  ContainerListItem,
  HealthStatus,
  Server,
  ServerList,
  ServerListItem,
  StatusCounts,
} from '@/api/types'
import { OVERVIEW_PAGE_SIZE, attentionOf, healthOf, summaryOf } from './overview'
import { countStatuses, emptyCounts } from './status'

const NOW = Date.parse('2026-10-17T10:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const server = (name: string, over: Partial<Server> = {}): Server => ({
  id: `srv-${name}`,
  name,
  hostname: `${name}.example.net`,
  ipAddress: '10.0.0.1',
  operatingSystem: 'Debian 12',
  status: 'online',
  siteId: 'site-a',
  lastSeenAt: iso(1),
  agentVersion: '0.4.2',
  telemetry: {
    cpuPercent: 20,
    memoryPercent: 30,
    diskPercent: 40,
    memoryTotalBytes: 1,
    diskTotalBytes: 1,
    uptimeSeconds: 1,
    collectedAt: iso(1),
    receivedAt: iso(1),
    stale: false,
  },
  ...over,
})

const serverItem = (
  name: string,
  health: HealthStatus,
  over: Partial<Server> = {},
  place: Partial<ServerListItem> = {},
): ServerListItem => ({
  server: server(name, over),
  health,
  customerName: 'Meridian',
  siteName: 'Athens DC',
  containers: { total: 0, counts: emptyCounts() },
  ...place,
})

const containerItem = (
  name: string,
  status: HealthStatus,
  host: string,
  over: Partial<ContainerListItem['container']> = {},
  place: Partial<ContainerListItem> = {},
): ContainerListItem => ({
  container: {
    id: `ctr-${name}-${host}`,
    serverId: `srv-${host}`,
    name,
    image: `${name}:1`,
    state: 'running',
    health: 'none',
    startedAt: iso(600),
    ...over,
  },
  status,
  serverName: host,
  customerName: 'Meridian',
  siteName: 'Athens DC',
  ...place,
})

const page = (total: number) => ({ number: 1, size: OVERVIEW_PAGE_SIZE, total, pages: 1 })

const serverList = (items: ServerListItem[], over: Partial<ServerList> = {}): ServerList => ({
  generatedAt: new Date(NOW).toISOString(),
  items,
  page: page(items.length),
  counts: countStatuses(items.map((item) => item.health)),
  scopeTotal: items.length,
  ...over,
})

const containerList = (
  items: ContainerListItem[],
  over: Partial<ContainerList> = {},
): ContainerList => ({
  generatedAt: new Date(NOW).toISOString(),
  items,
  page: page(items.length),
  counts: countStatuses(items.map((item) => item.status)),
  scopeTotal: items.length,
  ...over,
})

const STORY_SERVERS = [
  serverItem('pir-fs-01', 'critical', { status: 'offline', lastSeenAt: iso(14) }),
  serverItem('ath-db-01', 'warning', {
    telemetry: { ...server('x').telemetry!, diskPercent: 91 },
  }),
  serverItem('core-ci-01', 'unknown', { status: 'unknown', lastSeenAt: null, telemetry: null }),
  serverItem('ath-app-01', 'healthy'),
]
const STORY_CONTAINERS = [
  containerItem('pgbouncer', 'critical', 'ath-db-01', { health: 'unhealthy' }),
  containerItem('queue-worker', 'warning', 'ath-db-01', { state: 'restarting' }),
  containerItem('certbot', 'idle', 'ath-app-01', { state: 'exited' }),
  containerItem('nginx', 'healthy', 'ath-app-01'),
]

describe('summaryOf', () => {
  it('takes the totals and counts as the console API gave them', () => {
    const servers = serverList(STORY_SERVERS, { scopeTotal: 16 })
    const containers = containerList(STORY_CONTAINERS, { scopeTotal: 68 })
    const summary = summaryOf(servers, containers)
    expect(summary.generatedAt).toBe(servers.generatedAt)
    expect(summary.servers.total).toBe(16)
    expect(summary.containers.total).toBe(68)
    expect(summary.containers.counts).toEqual(containers.counts)
  })

  it('carries nothing but servers and containers: no invented target, device or alert figure', () => {
    const summary = summaryOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS))
    expect(Object.keys(summary).sort()).toEqual(['containers', 'generatedAt', 'servers'])
  })

  it('notes the servers that stopped reporting, inside critical, when every critical one is in hand', () => {
    const { servers } = summaryOf(serverList(STORY_SERVERS), containerList([]))
    expect(servers.counts).toMatchObject({ critical: 1, offline: 1 })
  })

  it('claims no offline share when more servers are critical than the page holds', () => {
    const servers = serverList(STORY_SERVERS, {
      counts: { ...countStatuses(STORY_SERVERS.map((item) => item.health)), critical: 500 },
    })
    expect(summaryOf(servers, containerList([])).servers.counts).not.toHaveProperty('offline')
  })

  it('notes no offline server where none is offline', () => {
    const { servers } = summaryOf(
      serverList([serverItem('a', 'critical'), serverItem('b', 'healthy')]),
      containerList([]),
    )
    expect(servers.counts).not.toHaveProperty('offline')
  })

  it('does not alias the lists: changing the summary leaves them alone', () => {
    const servers = serverList(STORY_SERVERS)
    const summary = summaryOf(servers, containerList([]))
    summary.servers.counts.healthy = 99
    expect(servers.counts.healthy).not.toBe(99)
  })
})

describe('attentionOf', () => {
  const attention = (includeIdle = false) =>
    attentionOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), {
      includeIdle,
      now: NOW,
    })

  it('lists what needs a look, worst first, then by name', () => {
    expect(attention().items.map((item) => `${item.severity}:${item.name}`)).toEqual([
      'critical:pgbouncer',
      'critical:pir-fs-01',
      'warning:ath-db-01',
      'warning:queue-worker',
      'unknown:core-ci-01',
    ])
  })

  it('counts idle containers instead of listing them, unless they are asked for', () => {
    expect(attention().hiddenIdle).toBe(1)
    expect(attention().items.some((item) => item.severity === 'idle')).toBe(false)
    const withIdle = attention(true)
    expect(withIdle.hiddenIdle).toBe(0)
    expect(withIdle.items.at(-1)).toMatchObject({ severity: 'idle', name: 'certbot' })
  })

  it('never lists a healthy entity', () => {
    expect(attention(true).items.map((item) => item.name)).not.toContain('nginx')
    expect(attention(true).items.map((item) => item.name)).not.toContain('ath-app-01')
  })

  it('describes an offline server by its last heartbeat and flags it', () => {
    expect(attention().items.find((item) => item.name === 'pir-fs-01')).toEqual({
      kind: 'server',
      id: 'srv-pir-fs-01',
      name: 'pir-fs-01',
      severity: 'critical',
      customerName: 'Meridian',
      siteName: 'Athens DC',
      stateLabel: 'OFFLINE',
      detail: 'offline · last heartbeat 14m ago',
      ageIso: iso(14),
      ageBasis: 'last-seen',
      offline: true,
    })
  })

  it('says "never reported" for a server that never did, with no age', () => {
    expect(attention().items.find((item) => item.name === 'core-ci-01')).toMatchObject({
      stateLabel: 'UNKNOWN',
      detail: 'never reported',
      ageIso: null,
      ageBasis: null,
    })
  })

  it('describes a resource problem by its readings, and claims no start time', () => {
    expect(attention().items.find((item) => item.name === 'ath-db-01')).toMatchObject({
      stateLabel: 'DEGRADED',
      detail: 'cpu 20% · mem 30% · disk 91%',
      ageIso: null,
      ageBasis: null,
    })
  })

  it('says a stale or missing reading is no reading, rather than showing numbers', () => {
    const stale = serverItem('stale-1', 'unknown', {
      telemetry: { ...server('x').telemetry!, stale: true, receivedAt: iso(30) },
    })
    const missing = serverItem('missing-1', 'unknown', { telemetry: null })
    const { items } = attentionOf(serverList([stale, missing]), containerList([]), { now: NOW })
    expect(items.find((item) => item.name === 'stale-1')).toMatchObject({
      stateLabel: 'NO READING',
      detail: 'reading is stale · last received 30m ago',
    })
    expect(items.find((item) => item.name === 'missing-1')).toMatchObject({
      stateLabel: 'NO READING',
      detail: 'heartbeats arrive, no telemetry yet',
    })
  })

  it('describes a container by its state and host, from the fields the API serves', () => {
    const find = (name: string) => attention(true).items.find((item) => item.name === name)
    expect(find('pgbouncer')).toMatchObject({
      kind: 'container',
      stateLabel: 'UNHEALTHY',
      detail: 'running · unhealthy on ath-db-01',
      hostName: 'ath-db-01',
      ageIso: null,
      ageBasis: null,
    })
    expect(find('queue-worker')).toMatchObject({
      stateLabel: 'RESTARTING',
      detail: 'restarting on ath-db-01',
    })
    expect(find('certbot')).toMatchObject({ stateLabel: 'EXITED', detail: 'exited on ath-app-01' })
  })

  it('leaves the place out for an entity on no site, instead of printing a blank', () => {
    const lonely = serverItem(
      'lonely',
      'critical',
      {},
      { customerName: undefined, siteName: undefined },
    )
    const { items } = attentionOf(serverList([lonely]), containerList([]), { now: NOW })
    expect(items[0]).not.toHaveProperty('customerName')
    expect(items[0]).not.toHaveProperty('siteName')
  })

  it('is empty, with nothing hidden, when nothing is monitored', () => {
    expect(attentionOf(serverList([]), containerList([]), { now: NOW })).toMatchObject({
      items: [],
      hiddenIdle: 0,
    })
  })
})

describe('healthOf', () => {
  const health = () => healthOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS))

  it('lists the four domains, with the two the console API does not serve marked planned and empty', () => {
    const { domains } = health()
    expect(domains.map((domain) => domain.domain)).toEqual([
      'servers',
      'containers',
      'targets',
      'snmp',
    ])
    expect(domains[0]).not.toHaveProperty('planned')
    expect(domains[1]).not.toHaveProperty('planned')
    for (const planned of domains.slice(2)) {
      expect(planned).toMatchObject({ planned: true })
      expect(planned.counts).toEqual(emptyCounts())
    }
  })

  it('counts the first two domains as the summary does', () => {
    const servers = serverList(STORY_SERVERS)
    const containers = containerList(STORY_CONTAINERS)
    const summary = summaryOf(servers, containers)
    const { domains } = healthOf(servers, containers)
    expect(domains[0]?.counts).toEqual(summary.servers.counts)
    expect(domains[1]?.counts).toEqual(summary.containers.counts)
  })

  it('puts servers and their containers on the site of the server, worst first', () => {
    const { sites } = health()
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({
      siteId: 'site-a',
      customerName: 'Meridian',
      siteName: 'Athens DC',
    })
    expect(sites[0]?.entities.map((entity) => `${entity.status}:${entity.name}`)).toEqual([
      'critical:pir-fs-01',
      'critical:pgbouncer@ath-db-01',
      'warning:ath-db-01',
      'warning:queue-worker@ath-db-01',
      'unknown:core-ci-01',
      'idle:certbot@ath-app-01',
      'healthy:ath-app-01',
      'healthy:nginx@ath-app-01',
    ])
  })

  it('flags the offline server and nothing else', () => {
    const flagged = health().sites.flatMap((site) =>
      site.entities.filter((entity) => entity.offline),
    )
    expect(flagged.map((entity) => entity.id)).toEqual(['srv-pir-fs-01'])
  })

  it('leaves a server with no site, and its containers, on no site', () => {
    const lonely = serverItem('lonely', 'critical', { siteId: null })
    const orphan = containerItem('orphan', 'warning', 'lonely')
    expect(healthOf(serverList([lonely]), containerList([orphan])).sites).toEqual([])
  })

  it('ranks the sites by their critical, then warning entities', () => {
    const quiet = serverItem(
      'quiet',
      'healthy',
      { siteId: 'site-q' },
      { siteName: 'Quiet', customerName: 'Acme' },
    )
    const loud = serverItem(
      'loud',
      'critical',
      { siteId: 'site-l' },
      { siteName: 'Loud', customerName: 'Acme' },
    )
    const { sites } = healthOf(serverList([quiet, loud]), containerList([]))
    expect(sites.map((site) => site.siteName)).toEqual(['Loud', 'Quiet'])
  })
})

describe('the overview page size', () => {
  it('is the most the console API serves in one page', () => {
    expect(OVERVIEW_PAGE_SIZE).toBe(200)
  })

  it('keeps the counts a type of StatusCounts', () => {
    const counts: StatusCounts = summaryOf(serverList([]), containerList([])).servers.counts
    expect(counts).toEqual(emptyCounts())
  })
})
