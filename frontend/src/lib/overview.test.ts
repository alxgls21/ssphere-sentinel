import { describe, expect, it } from 'vitest'
import type {
  ContainerList,
  ContainerListItem,
  DeviceList,
  DeviceListItem,
  HealthStatus,
  Server,
  ServerList,
  ServerListItem,
  StatusCounts,
  TargetList,
  TargetListItem,
} from '@/api/types'
import { item as targetItem, measurement } from '@/features/network/testing'
import { item as deviceItem, list as snmpList } from '@/features/snmp/testing'
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

const deviceList = (items: DeviceListItem[], over: Partial<DeviceList> = {}): DeviceList => ({
  ...snmpList(items),
  page: page(items.length),
  ...over,
})
const noDevices = deviceList([])

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
    const summary = summaryOf(servers, containers, noTargets, noDevices)
    expect(summary.generatedAt).toBe(servers.generatedAt)
    expect(summary.servers.total).toBe(16)
    expect(summary.containers.total).toBe(68)
    expect(summary.containers.counts).toEqual(containers.counts)
  })

  it('carries servers, containers, targets and devices and nothing else: no invented alert figure', () => {
    const summary = summaryOf(
      serverList(STORY_SERVERS),
      containerList(STORY_CONTAINERS),
      noTargets,
      noDevices,
    )
    expect(Object.keys(summary).sort()).toEqual([
      'containers',
      'devices',
      'generatedAt',
      'servers',
      'targets',
    ])
  })

  it('notes the servers that stopped reporting, inside critical, when every critical one is in hand', () => {
    const { servers } = summaryOf(
      serverList(STORY_SERVERS),
      containerList([]),
      noTargets,
      noDevices,
    )
    expect(servers.counts).toMatchObject({ critical: 1, offline: 1 })
  })

  it('claims no offline share when more servers are critical than the page holds', () => {
    const servers = serverList(STORY_SERVERS, {
      counts: { ...countStatuses(STORY_SERVERS.map((item) => item.health)), critical: 500 },
    })
    expect(
      summaryOf(servers, containerList([]), noTargets, noDevices).servers.counts,
    ).not.toHaveProperty('offline')
  })

  it('notes no offline server where none is offline', () => {
    const { servers } = summaryOf(
      serverList([serverItem('a', 'critical'), serverItem('b', 'healthy')]),
      containerList([]),
      noTargets,
      noDevices,
    )
    expect(servers.counts).not.toHaveProperty('offline')
  })

  it('does not alias the lists: changing the summary leaves them alone', () => {
    const servers = serverList(STORY_SERVERS)
    const summary = summaryOf(servers, containerList([]), noTargets, noDevices)
    summary.servers.counts.healthy = 99
    expect(servers.counts.healthy).not.toBe(99)
  })
})

describe('attentionOf', () => {
  const attention = (includeIdle = false) =>
    attentionOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets, noDevices, {
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
    const { items } = attentionOf(
      serverList([stale, missing]),
      containerList([]),
      noTargets,
      noDevices,
      {
        now: NOW,
      },
    )
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
    const { items } = attentionOf(serverList([lonely]), containerList([]), noTargets, noDevices, {
      now: NOW,
    })
    expect(items[0]).not.toHaveProperty('customerName')
    expect(items[0]).not.toHaveProperty('siteName')
  })

  it('is empty, with nothing hidden, when nothing is monitored', () => {
    expect(
      attentionOf(serverList([]), containerList([]), noTargets, noDevices, { now: NOW }),
    ).toMatchObject({
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
    const result = attentionOf(servers, boxes, noTargets, noDevices, { now: NOW })
    expect(result.items).toHaveLength(201)
    // 250 critical servers and 1 warning container exist; 200 + 1 are listed.
    expect(result.omitted).toBe(50)
  })

  it('says nothing is omitted when every problem is listed', () => {
    const result = attentionOf(
      serverList(STORY_SERVERS),
      containerList(STORY_CONTAINERS),
      noTargets,
      noDevices,
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
    const asked = attentionOf(serverList([]), containers, noTargets, noDevices, {
      includeIdle: true,
      now: NOW,
    })
    expect(asked.items).toHaveLength(1)
    expect(asked.hiddenIdle).toBe(4)
    expect(
      attentionOf(serverList([]), containers, noTargets, noDevices, { now: NOW }).hiddenIdle,
    ).toBe(5)
  })

  it('gives every site its figures when both lists are whole', () => {
    expect(
      healthOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets, noDevices),
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
    const health = healthOf(servers, containers, noTargets, noDevices)
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
    const health = healthOf(servers, boxes, noTargets, noDevices)
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
    const health = healthOf(servers, containers, noTargets, noDevices)
    expect(health.siteCoverage).toBe('none')
    expect(health.sites).toEqual([])
  })
})

describe('healthOf', () => {
  const health = () =>
    healthOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets, noDevices)

  it('lists the four domains, every one counted from the API', () => {
    const { domains } = health()
    expect(domains.map((domain) => domain.domain)).toEqual([
      'servers',
      'containers',
      'targets',
      'snmp',
    ])
    // Without a device in the lists, the SNMP row counts none.
    expect(domains[3]?.counts).toEqual(emptyCounts())
    expect(domains[3]).not.toHaveProperty('interfaces')
  })

  it('counts the first two domains as the summary does', () => {
    const servers = serverList(STORY_SERVERS)
    const containers = containerList(STORY_CONTAINERS)
    const summary = summaryOf(servers, containers, noTargets, noDevices)
    const { domains } = healthOf(servers, containers, noTargets, noDevices)
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
    expect(
      healthOf(serverList([lonely]), containerList([orphan]), noTargets, noDevices).sites,
    ).toEqual([])
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
    const { sites } = healthOf(serverList([quiet, loud]), containerList([]), noTargets, noDevices)
    expect(sites.map((site) => site.siteName)).toEqual(['Loud', 'Quiet'])
  })
})

describe('the overview page size', () => {
  it('is the most the console API serves in one page', () => {
    expect(OVERVIEW_PAGE_SIZE).toBe(200)
  })

  it('keeps the counts a type of StatusCounts', () => {
    const counts: StatusCounts = summaryOf(serverList([]), containerList([]), noTargets, noDevices)
      .servers.counts
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
    const summary = summaryOf(serverList([]), containerList([]), targets(), noDevices)
    expect(summary.targets).toEqual({
      total: 60,
      counts: { healthy: 52, warning: 2, critical: 1, unknown: 4, idle: 1 },
    })
  })

  it('lists the targets that need a look in the queue with the API’s health and reason', () => {
    const { items } = attentionOf(serverList([]), containerList([]), targets(), noDevices, {
      now: NOW,
    })
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
    const { items } = attentionOf(serverList([]), containerList([]), targets(), noDevices, {
      now: NOW,
    })
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
    const { items } = attentionOf(
      serverList([]),
      containerList([]),
      targetList([never]),
      noDevices,
      {
        now: NOW,
      },
    )
    expect(items[0]).toMatchObject({ ageIso: null, ageBasis: null, stateLabel: 'NO DATA' })
  })

  it('hides disabled targets behind the idle count, and lists them last when asked', () => {
    const hidden = attentionOf(serverList([]), containerList([]), targets(), noDevices, {
      now: NOW,
    })
    expect(hidden.hiddenIdle).toBe(1)
    expect(hidden.items.some((entry) => entry.severity === 'idle')).toBe(false)
    const asked = attentionOf(serverList([]), containerList([]), targets(), noDevices, {
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
    const result = attentionOf(servers, containerList([]), some, noDevices, { now: NOW })
    expect(result.items).toHaveLength(3)
    expect(result.omitted).toBe(2 + 2)
  })

  it('shows the targets domain row as counted, from the API, and the SNMP row as the devices counted', () => {
    const { domains } = healthOf(serverList([]), containerList([]), targets(), noDevices)
    expect(domains[2]).toEqual({
      domain: 'targets',
      label: 'NET TARGETS',
      counts: { healthy: 52, warning: 2, critical: 1, unknown: 4, idle: 1 },
    })
    // No device in the lists: the SNMP row is a count of none, never a figure made up.
    expect(domains[3]).toEqual({ domain: 'snmp', label: 'SNMP DEVS', counts: emptyCounts() })
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
      noDevices,
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
    expect(
      healthOf(serverList([]), containerList([]), targetList([lonely]), noDevices).sites,
    ).toEqual([])
  })

  it('is not whole while the targets are cut: only the problems are listed per site, and not the healthy', () => {
    const cut = targetList([TARGETS[0]!, TARGETS[5]!], {
      scopeTotal: 90,
      counts: { ...emptyCounts(), critical: 1, healthy: 89 },
    })
    const health = healthOf(serverList([]), containerList([]), cut, noDevices)
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
    const health = healthOf(serverList([]), containerList([]), overflow, noDevices)
    expect(health.siteCoverage).toBe('none')
    expect(health.sites).toEqual([])
    expect(health.domains[2]?.counts.critical).toBe(300)
  })

  it('counts into the verdict through the summary, by the API’s counts', async () => {
    const { computeVerdict } = await import('./verdict')
    const summary = summaryOf(
      serverList(STORY_SERVERS),
      containerList(STORY_CONTAINERS),
      targets(),
      noDevices,
    )
    const verdict = computeVerdict(summary, 'live')
    const without = computeVerdict(
      summaryOf(serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets, noDevices),
      'live',
    )
    // 1 critical + 2 warning + 4 unknown targets more need attention, of 59 more counted.
    expect(verdict.needAttention).toBe((without.needAttention ?? 0) + 7)
    expect(verdict.monitored).toBe(without.monitored + 59)
    expect(verdict.idle).toBe(without.idle + 1)
  })
})

describe('SNMP devices in the Overview', () => {
  const DEVICES = [
    deviceItem({
      id: 'd-down',
      name: 'pir-core',
      reason: 'unreachable',
      error: 'timeout',
      interfaces: { unknown: 48 },
    }),
    deviceItem({
      id: 'd-agent',
      name: 'edge-sw',
      reason: 'agent_offline',
      agent: 'offline',
      interfaces: { unknown: 24 },
    }),
    deviceItem({ id: 'd-stale', name: 'old-router', reason: 'stale', interfaces: { unknown: 8 } }),
    deviceItem({ id: 'd-new', name: 'fresh-sw', reason: 'no_poll', interfaces: {} }),
    deviceItem({ id: 'd-off', name: 'spare-fw', reason: 'disabled', interfaces: {} }),
    // Healthy, whatever its ports do: the API decides a device from its polls alone.
    deviceItem({
      id: 'd-ok',
      name: 'ath-core-sw',
      reason: 'ok',
      interfaces: { healthy: 20, idle: 3, warning: 5 },
    }),
    deviceItem({ id: 'd-ok2', name: 'ath-dist-sw', reason: 'ok', interfaces: { healthy: 10 } }),
  ]
  const devices = () =>
    deviceList(DEVICES, {
      scopeTotal: 120,
      counts: { ...emptyCounts(), healthy: 100, critical: 3, unknown: 9, idle: 8 },
    })
  const attention = (list: DeviceList, includeIdle = false) =>
    attentionOf(serverList([]), containerList([]), noTargets, list, { includeIdle, now: NOW })

  it('counts the devices from the API’s own total and counts, not from the rows', () => {
    const summary = summaryOf(serverList([]), containerList([]), noTargets, devices())
    expect(summary.devices).toEqual({
      total: 120,
      counts: { healthy: 100, warning: 0, critical: 3, unknown: 9, idle: 8 },
    })
  })

  it('says no device, never a made-up one, for a scope without devices', () => {
    const summary = summaryOf(serverList([]), containerList([]), noTargets, noDevices)
    expect(summary.devices).toEqual({ total: 0, counts: emptyCounts() })
  })

  it('lists the devices that need a look, worst first, with the API’s health and reason', () => {
    const { items } = attention(devices())
    expect(items.map((entry) => `${entry.severity}:${entry.name}`)).toEqual([
      'critical:pir-core',
      'unknown:edge-sw',
      'unknown:fresh-sw',
      'unknown:old-router',
    ])
    expect(items[0]).toMatchObject({
      kind: 'device',
      id: 'd-down',
      stateLabel: 'UNREACHABLE',
      siteName: 'Athens DC',
      customerName: 'Meridian',
      ageBasis: 'last-polled',
    })
    expect(items.map((entry) => entry.stateLabel)).toEqual([
      'UNREACHABLE',
      'AGENT OFFLINE',
      'NOT POLLED',
      'STALE',
    ])
  })

  it('does not list a healthy device because its interfaces are down', () => {
    const { items } = attention(devices())
    expect(items.map((entry) => entry.id)).not.toContain('d-ok')
    expect(items.map((entry) => entry.id)).not.toContain('d-ok2')
  })

  it('words a row from the reason, and never gives a stale or unreachable device a present response', () => {
    const { items } = attention(devices())
    const detail = (name: string) => items.find((entry) => entry.name === name)?.detail
    expect(detail('pir-core')).toBe('Switch 10.20.0.250 · no response: timeout')
    expect(detail('edge-sw')).toBe('Switch 10.20.0.250 · agent not reporting')
    expect(detail('fresh-sw')).toBe('Switch 10.20.0.250 · never polled')
    expect(detail('old-router')).toMatch(/last polled 2h ago, not current/)
  })

  it('dates a row by its latest poll, whatever its age, and gives a never-polled device no date', () => {
    const { items } = attention(devices())
    const down = items.find((entry) => entry.name === 'pir-core')
    expect(down?.ageIso).toBe(DEVICES[0]?.state?.lastPollAt)
    expect(items.find((entry) => entry.name === 'old-router')?.ageIso).toBe(
      DEVICES[2]?.state?.lastPollAt,
    )
    expect(items.find((entry) => entry.name === 'fresh-sw')).toMatchObject({
      ageIso: null,
      ageBasis: null,
    })
  })

  it('hides disabled devices behind the idle count, and lists them last when asked', () => {
    const hidden = attention(devices())
    expect(hidden.hiddenIdle).toBe(8)
    expect(hidden.items.some((entry) => entry.severity === 'idle')).toBe(false)
    const asked = attention(devices(), true)
    expect(asked.items.at(-1)).toMatchObject({
      name: 'spare-fw',
      severity: 'idle',
      stateLabel: 'DISABLED',
    })
    // One of the eight is in the rows: seven are beyond them.
    expect(asked.hiddenIdle).toBe(7)
  })

  it('counts the device problems beyond the rows from the API’s counts, with the other lists', () => {
    // 12 device problems exist (3 critical, 9 unknown) and 4 are listed.
    expect(attention(devices()).omitted).toBe(8)
    const whole = deviceList(DEVICES.slice(0, 4))
    expect(attention(whole).omitted).toBeUndefined()
  })

  it('shows the SNMP domain row as the devices counted, from the API', () => {
    const { domains } = healthOf(serverList([]), containerList([]), noTargets, devices())
    expect(domains[3]).toMatchObject({
      domain: 'snmp',
      label: 'SNMP DEVS',
      counts: { healthy: 100, warning: 0, critical: 3, unknown: 9, idle: 8 },
    })
    expect(domains[3]).not.toHaveProperty('planned')
  })

  describe('their interfaces', () => {
    it('are summed from the rows, and labelled partial while the rows are not every device', () => {
      const { domains } = healthOf(serverList([]), containerList([]), noTargets, devices())
      expect(domains[3]?.interfaces).toEqual({
        // 48 + 24 + 8 + 28 + 10 across the seven rows.
        total: 48 + 24 + 8 + 28 + 10,
        counts: { healthy: 30, warning: 5, critical: 0, unknown: 80, idle: 3 },
        devices: 7,
        of: 120,
        complete: false,
      })
    })

    it('are the scope’s only when every device of the scope is among the rows', () => {
      const { domains } = healthOf(
        serverList([]),
        containerList([]),
        noTargets,
        deviceList(DEVICES),
      )
      expect(domains[3]?.interfaces).toMatchObject({ devices: 7, of: 7, complete: true })
    })

    it('are the scope’s at the page boundary, and partial one device beyond it', () => {
      const page200 = Array.from({ length: OVERVIEW_PAGE_SIZE }, (_, n) =>
        deviceItem({ id: `d-${n}`, name: `d-${n}`, reason: 'ok', interfaces: { healthy: 2 } }),
      )
      const at = (scopeTotal: number) =>
        healthOf(
          serverList([]),
          containerList([]),
          noTargets,
          deviceList(page200, {
            scopeTotal,
            counts: { ...emptyCounts(), healthy: scopeTotal },
          }),
        ).domains[3]?.interfaces
      expect(at(OVERVIEW_PAGE_SIZE)).toMatchObject({ total: 400, devices: 200, complete: true })
      expect(at(OVERVIEW_PAGE_SIZE + 1)).toMatchObject({
        total: 400,
        devices: 200,
        of: 201,
        complete: false,
      })
    })

    it('are not given for a scope without devices', () => {
      const { domains } = healthOf(serverList([]), containerList([]), noTargets, noDevices)
      expect(domains[3]).not.toHaveProperty('interfaces')
    })

    it('never change a device’s health or the device counts', () => {
      const quiet = DEVICES.map((entry) => ({
        ...entry,
        interfaces: { total: 0, counts: emptyCounts() },
      }))
      const noisy = healthOf(serverList([]), containerList([]), noTargets, deviceList(DEVICES))
      const none = healthOf(serverList([]), containerList([]), noTargets, deviceList(quiet))
      expect(noisy.domains[3]?.counts).toEqual(none.domains[3]?.counts)
      expect(attention(deviceList(DEVICES)).items.map((entry) => entry.id)).toEqual(
        attention(deviceList(quiet)).items.map((entry) => entry.id),
      )
    })
  })

  it('puts a device on its own site, beside the servers and containers there', () => {
    const here = (entry: DeviceListItem): DeviceListItem => ({
      ...entry,
      device: { ...entry.device, siteId: 'site-a' },
    })
    const health = healthOf(
      serverList(STORY_SERVERS),
      containerList(STORY_CONTAINERS),
      noTargets,
      deviceList([here(DEVICES[0]!), here(DEVICES[5]!)]),
    )
    expect(health).not.toHaveProperty('siteCoverage')
    const names = health.sites[0]?.entities.map((entity) => `${entity.kind}:${entity.name}`)
    expect(names).toContain('device:pir-core')
    expect(names).toContain('device:ath-core-sw')
    expect(names?.indexOf('device:pir-core')).toBeLessThan(
      names?.indexOf('device:ath-core-sw') ?? 0,
    )
  })

  it('leaves a device with no site on none', () => {
    const lonely = deviceItem({ id: 'd-none', name: 'free', reason: 'unreachable', siteName: null })
    expect(
      healthOf(serverList([]), containerList([]), noTargets, deviceList([lonely])).sites,
    ).toEqual([])
  })

  it('is not whole while the devices are cut: only the problems are listed per site', () => {
    const cut = deviceList([DEVICES[0]!, DEVICES[5]!], {
      scopeTotal: 90,
      counts: { ...emptyCounts(), critical: 1, healthy: 89 },
    })
    const health = healthOf(serverList([]), containerList([]), noTargets, cut)
    expect(health.siteCoverage).toBe('problems')
    expect(health.sites[0]?.entities.map((entity) => entity.name)).toEqual(['pir-core'])
    expect(health.domains[3]?.counts.healthy).toBe(89)
  })

  it('gives no per-site figure when the device problems alone do not fit the rows', () => {
    const many = Array.from({ length: 200 }, (_, n) =>
      deviceItem({ id: `d-${n}`, name: `d-${String(n).padStart(3, '0')}`, reason: 'unreachable' }),
    )
    const overflow = deviceList(many, {
      scopeTotal: 400,
      counts: { ...emptyCounts(), critical: 300, healthy: 100 },
    })
    const health = healthOf(serverList([]), containerList([]), noTargets, overflow)
    expect(health.siteCoverage).toBe('none')
    expect(health.sites).toEqual([])
    expect(health.domains[3]?.counts.critical).toBe(300)
  })

  it('counts into the verdict through the summary, by the API’s counts', async () => {
    const { computeVerdict } = await import('./verdict')
    const base = [serverList(STORY_SERVERS), containerList(STORY_CONTAINERS), noTargets] as const
    const verdict = computeVerdict(summaryOf(...base, devices()), 'live')
    const without = computeVerdict(summaryOf(...base, noDevices), 'live')
    // 3 critical + 9 unknown devices more need attention, of 112 more counted.
    expect(verdict.needAttention).toBe((without.needAttention ?? 0) + 12)
    expect(verdict.monitored).toBe(without.monitored + 112)
    expect(verdict.idle).toBe(without.idle + 8)
  })
})
