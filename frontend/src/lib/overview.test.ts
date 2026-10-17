import { describe, expect, it } from 'vitest'
import type {
  ContainerList,
  ContainerListItem,
  HealthStatus,
  Server,
  ServerList,
  ServerListItem,
  StatusCounts,
  TargetList,
  TargetListItem,
} from '@/api/types'
import { item as targetItem, measurement } from '@/features/network/testing'
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

const targetList = (items: TargetListItem[], over: Partial<TargetList> = {}): TargetList => ({
  generatedAt: new Date(NOW).toISOString(),
  items,
  page: page(items.length),
  counts: countStatuses(items.map((entry) => entry.health)),
  scopeTotal: items.length,
  ...over,
})
const noTargets = targetList([])

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
    const summary = summaryOf(servers, containers, noTargets)
    expect(summary.generatedAt).toBe(servers.generatedAt)
    expect(summary.servers.total).toBe(16)
    expect(summary.containers.total).toBe(68)
    expect(summary.containers.counts).toEqual(containers.counts)
  })

  it('carries servers, containers and targets and nothing else: no invented device or alert figure', () => {
    const summary = summaryOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets)
    expect(Object.keys(summary).sort()).toEqual(['containers', 'generatedAt', 'servers', 'targets'])
  })

  it('notes the servers that stopped reporting, inside critical, when every critical one is in hand', () => {
    const { servers } = summaryOf(serverList(STORY_SERVERS), containerList([]), noTargets)
    expect(servers.counts).toMatchObject({ critical: 1, offline: 1 })
  })

  it('claims no offline share when more servers are critical than the page holds', () => {
    const servers = serverList(STORY_SERVERS, {
      counts: { ...countStatuses(STORY_SERVERS.map((item) => item.health)), critical: 500 },
    })
    expect(summaryOf(servers, containerList([]), noTargets).servers.counts).not.toHaveProperty(
      'offline',
    )
  })

  it('notes no offline server where none is offline', () => {
    const { servers } = summaryOf(
      serverList([serverItem('a', 'critical'), serverItem('b', 'healthy')]),
      containerList([]),
      noTargets,
    )
    expect(servers.counts).not.toHaveProperty('offline')
  })

  it('does not alias the lists: changing the summary leaves them alone', () => {
    const servers = serverList(STORY_SERVERS)
    const summary = summaryOf(servers, containerList([]), noTargets)
    summary.servers.counts.healthy = 99
    expect(servers.counts.healthy).not.toBe(99)
  })
})

describe('attentionOf', () => {
  const attention = (includeIdle = false) =>
    attentionOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets, {
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
    const { items } = attentionOf(serverList([stale, missing]), containerList([]), noTargets, {
      now: NOW,
    })
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
    const { items } = attentionOf(serverList([lonely]), containerList([]), noTargets, { now: NOW })
    expect(items[0]).not.toHaveProperty('customerName')
    expect(items[0]).not.toHaveProperty('siteName')
  })

  it('is empty, with nothing hidden, when nothing is monitored', () => {
    expect(attentionOf(serverList([]), containerList([]), noTargets, { now: NOW })).toMatchObject({
      items: [],
      hiddenIdle: 0,
    })
  })
})

describe('what the worst-first rows cannot reach', () => {
  /** Many more servers and containers than the rows hold: the counts are the API's, the rows are a page. */
  const big = (
    problemsOnPage: number,
    extra: { serversTotal: number; containersTotal: number },
  ) => {
    const items = Array.from({ length: problemsOnPage }, (_, n) =>
      serverItem(`srv-${String(n).padStart(3, '0')}`, 'critical'),
    )
    const servers = serverList(items, {
      counts: { ...emptyCounts(), critical: 250, healthy: extra.serversTotal - 250 },
      scopeTotal: extra.serversTotal,
      page: { number: 1, size: 200, total: extra.serversTotal, pages: 2 },
    })
    const boxes = containerList([containerItem('c', 'warning', 'srv-000')], {
      counts: { ...emptyCounts(), warning: 1, healthy: extra.containersTotal - 1 },
      scopeTotal: extra.containersTotal,
      page: { number: 1, size: 200, total: extra.containersTotal, pages: 1 },
    })
    return { servers, boxes }
  }

  it('counts the problems the queue does not list, from the API’s own counts', () => {
    const { servers, boxes } = big(200, { serversTotal: 600, containersTotal: 1 })
    const result = attentionOf(servers, boxes, noTargets, { now: NOW })
    expect(result.items).toHaveLength(201)
    // 250 critical servers and 1 warning container exist; 200 + 1 are listed.
    expect(result.omitted).toBe(50)
  })

  it('says nothing is omitted when every problem is listed', () => {
    const result = attentionOf(
      serverList(STORY_SERVERS),
      containerList(STORY_CONTAINERS),
      noTargets,
      {
        now: NOW,
      },
    )
    expect(result).not.toHaveProperty('omitted')
  })

  it('keeps the idle containers beyond the rows hidden, even when idle ones are asked for', () => {
    const idle = containerItem('certbot', 'idle', 'ath-app-01', { state: 'exited' })
    const containers = containerList([idle], {
      counts: { ...emptyCounts(), idle: 5, healthy: 20 },
      scopeTotal: 25,
    })
    const asked = attentionOf(serverList([]), containers, noTargets, {
      includeIdle: true,
      now: NOW,
    })
    expect(asked.items).toHaveLength(1)
    expect(asked.hiddenIdle).toBe(4)
    expect(attentionOf(serverList([]), containers, noTargets, { now: NOW }).hiddenIdle).toBe(5)
  })

  it('gives every site its figures when both lists are whole', () => {
    expect(
      healthOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets),
    ).not.toHaveProperty('siteCoverage')
  })

  it('lists only the problems of a site when the lists are cut but every problem is in hand', () => {
    const servers = serverList([serverItem('bad', 'critical'), serverItem('fine', 'healthy')], {
      counts: { ...emptyCounts(), critical: 1, healthy: 99 },
      scopeTotal: 100,
    })
    const containers = containerList([containerItem('worker', 'warning', 'bad')], {
      counts: { ...emptyCounts(), warning: 1, healthy: 49 },
      scopeTotal: 50,
    })
    const health = healthOf(servers, containers, noTargets)
    expect(health.siteCoverage).toBe('problems')
    expect(health.sites).toHaveLength(1)
    // The healthy server in the rows is not counted either: its site's healthy members are not known.
    expect(health.sites[0]?.entities.map((entity) => entity.name)).toEqual(['bad', 'worker@bad'])
    // The domain counts stay the API's, whole.
    expect(health.domains[0]?.counts.healthy).toBe(99)
    expect(health.domains[1]?.counts.healthy).toBe(49)
  })

  it('gives no per-site figure when the problems alone do not fit the rows', () => {
    const { servers, boxes } = big(200, { serversTotal: 600, containersTotal: 1 })
    const health = healthOf(servers, boxes, noTargets)
    expect(health.siteCoverage).toBe('none')
    expect(health.sites).toEqual([])
    expect(health.domains[0]?.counts.critical).toBe(250)
  })

  it('gives no per-site figure when a problem runs on a host beyond the rows', () => {
    const servers = serverList([serverItem('bad', 'critical')], {
      counts: { ...emptyCounts(), critical: 1, healthy: 99 },
      scopeTotal: 100,
    })
    const containers = containerList([containerItem('worker', 'warning', 'elsewhere')], {
      counts: { ...emptyCounts(), warning: 1, healthy: 9 },
      scopeTotal: 10,
    })
    const health = healthOf(servers, containers, noTargets)
    expect(health.siteCoverage).toBe('none')
    expect(health.sites).toEqual([])
  })
})

describe('healthOf', () => {
  const health = () =>
    healthOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets)

  it('lists the four domains, with only SNMP, which the console API does not serve, planned and empty', () => {
    const { domains } = health()
    expect(domains.map((domain) => domain.domain)).toEqual([
      'servers',
      'containers',
      'targets',
      'snmp',
    ])
    for (const counted of domains.slice(0, 3)) expect(counted).not.toHaveProperty('planned')
    expect(domains[3]).toMatchObject({ planned: true })
    expect(domains[3]?.counts).toEqual(emptyCounts())
  })

  it('counts the first two domains as the summary does', () => {
    const servers = serverList(STORY_SERVERS)
    const containers = containerList(STORY_CONTAINERS)
    const summary = summaryOf(servers, containers, noTargets)
    const { domains } = healthOf(servers, containers, noTargets)
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
    expect(healthOf(serverList([lonely]), containerList([orphan]), noTargets).sites).toEqual([])
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
    const { sites } = healthOf(serverList([quiet, loud]), containerList([]), noTargets)
    expect(sites.map((site) => site.siteName)).toEqual(['Loud', 'Quiet'])
  })
})

describe('the overview page size', () => {
  it('is the most the console API serves in one page', () => {
    expect(OVERVIEW_PAGE_SIZE).toBe(200)
  })

  it('keeps the counts a type of StatusCounts', () => {
    const counts: StatusCounts = summaryOf(serverList([]), containerList([]), noTargets).servers
      .counts
    expect(counts).toEqual(emptyCounts())
  })
})

describe('probe targets in the Overview', () => {
  const TARGETS = [
    targetItem({
      id: 't-fail',
      name: 'pir-gateway',
      reason: 'failing',
      latest: measurement({
        success: false,
        latencyMs: null,
        lossPercent: 100,
        failureReason: 'timeout',
      }),
    }),
    targetItem({
      id: 't-slow',
      name: 'cdn-edge',
      protocol: 'tcp',
      reason: 'latency',
      latest: measurement({ latencyMs: 212 }),
    }),
    targetItem({
      id: 't-lossy',
      name: 'api-https',
      protocol: 'tcp',
      reason: 'loss',
      latest: measurement({ lossPercent: 6 }),
    }),
    targetItem({ id: 't-stale', name: 'old-probe', reason: 'stale' }),
    targetItem({ id: 't-off', name: 'spare', reason: 'disabled' }),
    targetItem({ id: 't-ok', name: 'ath-gateway', reason: 'ok' }),
  ]
  const targets = () =>
    targetList(TARGETS, {
      scopeTotal: 60,
      counts: { ...emptyCounts(), healthy: 52, critical: 1, warning: 2, unknown: 4, idle: 1 },
    })

  it('counts the targets from the API’s own total and counts, not from the rows', () => {
    const summary = summaryOf(serverList([]), containerList([]), targets())
    expect(summary.targets).toEqual({
      total: 60,
      counts: { healthy: 52, warning: 2, critical: 1, unknown: 4, idle: 1 },
    })
  })

  it('lists the targets that need a look in the queue with the API’s health and reason', () => {
    const { items } = attentionOf(serverList([]), containerList([]), targets(), { now: NOW })
    expect(items.map((entry) => `${entry.severity}:${entry.name}`)).toEqual([
      'critical:pir-gateway',
      'warning:api-https',
      'warning:cdn-edge',
      'unknown:old-probe',
    ])
    expect(items.find((entry) => entry.name === 'pir-gateway')).toMatchObject({
      kind: 'target',
      id: 't-fail',
      stateLabel: 'FAILING',
      siteName: 'Athens DC',
      customerName: 'Meridian',
      ageBasis: 'last-measured',
    })
  })

  it('words a row from the reason and the newest measurement, per protocol, without a limit it does not have', () => {
    const { items } = attentionOf(serverList([]), containerList([]), targets(), { now: NOW })
    const detail = (name: string) => items.find((entry) => entry.name === name)?.detail
    expect(detail('pir-gateway')).toBe('ICMP 10.20.0.1 · latest measurements all failed: timeout')
    expect(detail('cdn-edge')).toBe('TCP 443 api.example.net:443 · latency 212 ms')
    expect(detail('api-https')).toBe(
      'TCP 443 api.example.net:443 · 6.0% of connection attempts failed',
    )
    expect(detail('old-probe')).toMatch(/last measured 20s ago, not current/)
    expect(detail('cdn-edge')).not.toMatch(/packet/i)
  })

  it('dates a row by its newest measurement and gives a never-measured target no date', () => {
    const never = targetItem({
      id: 't-never',
      name: 'fresh',
      reason: 'no_measurement',
      latest: null,
    })
    const { items } = attentionOf(serverList([]), containerList([]), targetList([never]), {
      now: NOW,
    })
    expect(items[0]).toMatchObject({ ageIso: null, ageBasis: null, stateLabel: 'NO DATA' })
  })

  it('hides disabled targets behind the idle count, and lists them last when asked', () => {
    const hidden = attentionOf(serverList([]), containerList([]), targets(), { now: NOW })
    expect(hidden.hiddenIdle).toBe(1)
    expect(hidden.items.some((entry) => entry.severity === 'idle')).toBe(false)
    const asked = attentionOf(serverList([]), containerList([]), targets(), {
      includeIdle: true,
      now: NOW,
    })
    expect(asked.items.at(-1)).toMatchObject({
      name: 'spare',
      severity: 'idle',
      stateLabel: 'DISABLED',
    })
    expect(asked.hiddenIdle).toBe(0)
  })

  it('counts the problems beyond the rows of every list together, from the API’s counts', () => {
    // 1 critical server listed of 3 that exist; 2 target problems exist beyond the 2 listed.
    const servers = serverList([serverItem('bad', 'critical')], {
      counts: { ...emptyCounts(), critical: 3, healthy: 10 },
      scopeTotal: 13,
    })
    const some = targetList(TARGETS.slice(0, 2), {
      counts: { ...emptyCounts(), critical: 1, warning: 3, healthy: 20 },
      scopeTotal: 24,
    })
    const result = attentionOf(servers, containerList([]), some, { now: NOW })
    expect(result.items).toHaveLength(3)
    expect(result.omitted).toBe(2 + 2)
  })

  it('shows the targets domain row as counted, from the API, and leaves SNMP planned', () => {
    const { domains } = healthOf(serverList([]), containerList([]), targets())
    expect(domains[2]).toEqual({
      domain: 'targets',
      label: 'NET TARGETS',
      counts: { healthy: 52, warning: 2, critical: 1, unknown: 4, idle: 1 },
    })
    expect(domains[3]).toMatchObject({ domain: 'snmp', planned: true })
  })

  it('puts a target on its own site, beside the servers and containers there', () => {
    // The same site as the story's servers.
    const here = (entry: TargetListItem): TargetListItem => ({
      ...entry,
      target: { ...entry.target, siteId: 'site-a' },
    })
    const health = healthOf(
      serverList(STORY_SERVERS),
      containerList(STORY_CONTAINERS),
      targetList([here(TARGETS[0]!), here(TARGETS[5]!)]),
    )
    expect(health).not.toHaveProperty('siteCoverage')
    const names = health.sites[0]?.entities.map((entity) => `${entity.kind}:${entity.name}`)
    expect(names).toContain('target:pir-gateway')
    expect(names).toContain('target:ath-gateway')
    // Worst first, and a server before a container before a target at the same level.
    expect(names?.indexOf('target:pir-gateway')).toBeLessThan(
      names?.indexOf('target:ath-gateway') ?? 0,
    )
  })

  it('leaves a target with no site on none', () => {
    const lonely = targetItem({ id: 't-no-site', name: 'free', reason: 'failing', siteName: null })
    expect(healthOf(serverList([]), containerList([]), targetList([lonely])).sites).toEqual([])
  })

  it('is not whole while the targets are cut: only the problems are listed per site, and not the healthy', () => {
    const cut = targetList([TARGETS[0]!, TARGETS[5]!], {
      scopeTotal: 90,
      counts: { ...emptyCounts(), critical: 1, healthy: 89 },
    })
    const health = healthOf(serverList([]), containerList([]), cut)
    expect(health.siteCoverage).toBe('problems')
    expect(health.sites[0]?.entities.map((entity) => entity.name)).toEqual(['pir-gateway'])
    // The domain row stays the API's whole count.
    expect(health.domains[2]?.counts.healthy).toBe(89)
  })

  it('gives no per-site figure when the target problems alone do not fit the rows', () => {
    const many = Array.from({ length: 200 }, (_, n) =>
      targetItem({ id: `t-${n}`, name: `t-${String(n).padStart(3, '0')}`, reason: 'failing' }),
    )
    const overflow = targetList(many, {
      scopeTotal: 400,
      counts: { ...emptyCounts(), critical: 300, healthy: 100 },
    })
    const health = healthOf(serverList([]), containerList([]), overflow)
    expect(health.siteCoverage).toBe('none')
    expect(health.sites).toEqual([])
    expect(health.domains[2]?.counts.critical).toBe(300)
  })

  it('counts into the verdict through the summary, by the API’s counts', async () => {
    const { computeVerdict } = await import('./verdict')
    const summary = summaryOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), targets())
    const verdict = computeVerdict(summary, 'live')
    const without = computeVerdict(
      summaryOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets),
      'live',
    )
    // 1 critical + 2 warning + 4 unknown targets more need attention, of 59 more counted.
    expect(verdict.needAttention).toBe((without.needAttention ?? 0) + 7)
    expect(verdict.monitored).toBe(without.monitored + 59)
    expect(verdict.idle).toBe(without.idle + 1)
  })
})
