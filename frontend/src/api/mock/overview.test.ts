import { describe, expect, it } from 'vitest'
import type { SentinelApi } from '@/api/client'
import {
  ALL_SCOPE,
  type AttentionItem,
  type HealthStatus,
  type LoadMetric,
  type Scope,
  type StatusCounts,
} from '@/api/types'
import { listAttention } from './attention'
import { createMockApi } from './client'
import { buildEstate } from './fixtures'
import type { MockScenario } from './scenario'

const NOW = Date.UTC(2026, 9, 12, 14, 5, 12)

const apiFor = (scenario: MockScenario = 'normal'): SentinelApi =>
  createMockApi({ scenario, now: () => NOW, delayMs: 0 })

const site = (siteId: string): Scope => ({ customerId: null, siteId })
const customer = (customerId: string): Scope => ({ customerId, siteId: null })
/** The total of the health statuses: offline is already inside critical, so it is not added again. */
const sum = ({ offline: _offline, ...health }: StatusCounts) =>
  Object.values(health).reduce((a, b) => a + b, 0)
const count = (items: { severity: string }[], severity: string) =>
  items.filter((item) => item.severity === severity).length

describe('consistency across panels', () => {
  for (const scenario of ['normal', 'healthy', 'partial'] as const) {
    describe(scenario, () => {
      const api = apiFor(scenario)

      it('summary counts equal the attention queue plus the healthy rest', async () => {
        const summary = await api.getOverviewSummary()
        const { items, hiddenIdle } = await api.listAttention({ includeIdle: true })
        const domains = [
          ['server', summary.servers],
          ['container', summary.containers],
          ['target', summary.targets],
        ] as const
        for (const [kind, domain] of domains) {
          const mine = items.filter((item) => item.kind === kind)
          const { counts } = domain
          expect(count(mine, 'critical'), `${kind} critical`).toBe(counts.critical)
          expect(count(mine, 'warning'), `${kind} warning`).toBe(counts.warning)
          expect(count(mine, 'unknown'), `${kind} unknown`).toBe(counts.unknown)
          expect(count(mine, 'idle'), `${kind} idle`).toBe(counts.idle)
          expect(mine.length + counts.healthy, `${kind} total`).toBe(domain.total)
          expect(sum(counts)).toBe(domain.total)
        }
        expect(hiddenIdle).toBe(0)
      })

      it('hides idle items behind a count by default, and shows them last on request', async () => {
        const summary = await api.getOverviewSummary()
        const idle =
          summary.servers.counts.idle + summary.containers.counts.idle + summary.targets.counts.idle
        const hidden = await api.listAttention()
        expect(hidden.hiddenIdle).toBe(idle)
        expect(hidden.items.some((item) => item.severity === 'idle')).toBe(false)
        const shown = await api.listAttention({ includeIdle: true })
        expect(shown.items).toHaveLength(hidden.items.length + idle)
        expect(shown.items.slice(0, hidden.items.length)).toEqual(hidden.items)
        expect(
          shown.items.slice(hidden.items.length).every((item) => item.severity === 'idle'),
        ).toBe(true)
      })

      it('health breakdown domains equal the summary counts', async () => {
        const [summary, breakdown] = await Promise.all([
          api.getOverviewSummary(),
          api.getHealthBreakdown(),
        ])
        const domain = (name: string) => breakdown.domains.find((d) => d.domain === name)
        expect(domain('servers')?.counts).toEqual(summary.servers.counts)
        expect(domain('containers')?.counts).toEqual(summary.containers.counts)
        expect(domain('targets')?.counts).toEqual(summary.targets.counts)
        expect(domain('servers')?.planned).toBeUndefined()
        expect(domain('snmp')).toMatchObject({ planned: true, label: 'SNMP DEVS' })
        expect(domain('snmp')?.counts).toEqual({
          healthy: 0,
          warning: 0,
          critical: 0,
          unknown: summary.devices.inInventory,
          idle: 0,
        })
      })

      it('every site entity is a monitored entity, once, with the status the index reports', async () => {
        const [breakdown, index] = await Promise.all([
          api.getHealthBreakdown(),
          api.getEntityIndex(),
        ])
        const status = new Map(index.items.map((item) => [item.id, item.status]))
        const seen = new Set<string>()
        for (const { entities } of breakdown.sites) {
          for (const entity of entities) {
            expect(seen.has(entity.id), entity.id).toBe(false)
            seen.add(entity.id)
            expect(status.get(entity.id), entity.id).toBe(entity.status)
          }
        }
      })

      it('entity index holds servers, containers, targets, devices, sites and customers', async () => {
        const [summary, scopes, index] = await Promise.all([
          api.getOverviewSummary(),
          api.getScopeOptions(),
          api.getEntityIndex(),
        ])
        expect(index.items).toHaveLength(
          summary.servers.total +
            summary.containers.total +
            summary.targets.total +
            summary.devices.inInventory +
            scopes.sites.length +
            scopes.customers.length,
        )
        const ids = index.items.map((item) => item.id)
        expect(new Set(ids).size).toBe(ids.length)
      })

      it('every attention item exists in the index with the same status', async () => {
        const [{ items }, index] = await Promise.all([
          api.listAttention({ includeIdle: true }),
          api.getEntityIndex(),
        ])
        const byId = new Map(index.items.map((item) => [item.id, item]))
        for (const item of items) {
          const found = byId.get(item.id)
          expect(found, item.id).toBeDefined()
          expect(found?.kind).toBe(item.kind)
          expect(found?.name).toBe(item.name)
          expect(found?.status).toBe(item.severity)
        }
      })
    })
  }

  it('summary says the story: 16 servers, 14 online, one critical', async () => {
    const summary = await apiFor().getOverviewSummary()
    expect(summary.servers).toMatchObject({ total: 16, online: 14 })
    expect(summary.servers.counts).toEqual({
      healthy: 11,
      warning: 3,
      critical: 1,
      unknown: 1,
      idle: 0,
      offline: 1,
    })
    expect(summary.containers.running).toBeLessThan(summary.containers.total)
    expect(summary.targets.up).toBeLessThan(summary.targets.total)
    expect(summary.targets.successTrend).toHaveLength(12)
    expect(summary.devices.inInventory).toBe(12)
    expect(Object.values(summary.devices.byType).reduce((a, b) => a + b, 0)).toBe(12)
  })
})

describe('scope', () => {
  const api = apiFor()

  it('narrows every method to a site', async () => {
    const scope = site('site-fra-dc')
    const [summary, attention, load, breakdown, index, series] = await Promise.all([
      api.getOverviewSummary({ scope }),
      api.listAttention({ scope, includeIdle: true }),
      api.getFleetLoad({ scope, metric: 'cpu' }),
      api.getHealthBreakdown({ scope }),
      api.getEntityIndex({ scope }),
      api.getNetworkSeries({ scope, range: '1h' }),
    ])
    expect(summary.servers.total).toBe(4)
    expect(summary.devices.inInventory).toBe(3)
    expect(attention.items.length).toBeGreaterThan(0)
    expect(attention.items.every((item) => item.siteName === 'Frankfurt DC')).toBe(true)
    expect(attention.items.every((item) => item.customerName === 'Northwind Retail')).toBe(true)
    expect(load.rows.map((row) => row.name).sort()).toEqual([
      'fra-cache-01',
      'fra-db-01',
      'fra-web-01',
      'fra-web-02',
    ])
    expect(breakdown.sites.map((entry) => entry.siteName)).toEqual(['Frankfurt DC'])
    expect(index.items.some((item) => item.id === 'srv-ath-app-01')).toBe(false)
    expect(index.items.some((item) => item.id === 'srv-fra-web-01')).toBe(true)
    expect(series.targetCount).toBe(summary.targets.total)
    expect(sum(summary.targets.counts)).toBe(summary.targets.total)
  })

  it('partitions the estate: the sites add up to everything that has a site', async () => {
    const all = await api.getOverviewSummary()
    const { sites } = await api.getScopeOptions()
    const parts = await Promise.all(sites.map((s) => api.getOverviewSummary({ scope: site(s.id) })))
    const total = (pick: (s: (typeof parts)[number]) => number) =>
      parts.reduce((n, s) => n + pick(s), 0)
    expect(total((s) => s.servers.total)).toBe(all.servers.total)
    expect(total((s) => s.containers.total)).toBe(all.containers.total)
    expect(total((s) => s.devices.inInventory)).toBe(all.devices.inInventory)
    // Two public probes belong to no site.
    expect(total((s) => s.targets.total)).toBe(all.targets.total - 2)
    expect(total((s) => s.servers.counts.critical)).toBe(all.servers.counts.critical)
    expect(total((s) => s.containers.counts.unknown)).toBe(all.containers.counts.unknown)
  })

  it('narrows to a customer as the union of its sites', async () => {
    const [whole, athens, piraeus] = await Promise.all([
      api.getOverviewSummary({ scope: customer('cus-meridian') }),
      api.getOverviewSummary({ scope: site('site-ath-dc') }),
      api.getOverviewSummary({ scope: site('site-pir-depot') }),
    ])
    expect(whole.servers.total).toBe(athens.servers.total + piraeus.servers.total)
    expect(whole.targets.total).toBe(athens.targets.total + piraeus.targets.total)
    expect(whole.containers.counts.critical).toBe(
      athens.containers.counts.critical + piraeus.containers.counts.critical,
    )
  })

  it('selects nothing for a mismatched customer and site', async () => {
    const scope: Scope = { customerId: 'cus-halcyon', siteId: 'site-fra-dc' }
    expect((await api.getOverviewSummary({ scope })).servers.total).toBe(0)
    expect((await api.listAttention({ scope })).items).toEqual([])
    expect((await api.getEntityIndex({ scope })).items).toEqual([])
  })

  it('treats the explicit "everything" scope as no scope', async () => {
    expect(await api.getOverviewSummary({ scope: ALL_SCOPE })).toEqual(
      await api.getOverviewSummary(),
    )
  })

  it('offers every customer and site to the picker, whatever the scope', async () => {
    const options = await api.getScopeOptions()
    expect(options.customers).toHaveLength(4)
    expect(options.sites).toHaveLength(7)
    for (const entry of options.sites) {
      expect(options.customers.some((c) => c.id === entry.customerId)).toBe(true)
    }
  })

  it('keeps alerts and events inside the scope', async () => {
    const scope = site('site-pir-depot')
    const alerts = await api.listAlerts({ scope })
    expect(alerts.length).toBeGreaterThan(0)
    expect(alerts.every((alert) => alert.siteId === 'site-pir-depot')).toBe(true)
    const events = await api.listEvents({ scope })
    expect(events.length).toBeGreaterThan(0)
    const everyone = new Set(
      (await api.getEntityIndex({ scope })).items.flatMap((item) => [item.id]),
    )
    for (const event of events) expect(everyone.has(event.subject.id), event.subject.id).toBe(true)
  })
})

describe('needs-attention', () => {
  const rank: Record<string, number> = { critical: 0, warning: 1, unknown: 2, idle: 3 }

  it('is ordered by severity, then newest first (no timestamp last), then name', async () => {
    const { items } = await apiFor().listAttention({ includeIdle: true })
    for (let i = 1; i < items.length; i += 1) {
      const a = items[i - 1] as AttentionItem
      const b = items[i] as AttentionItem
      const ranks = [rank[a.severity] as number, rank[b.severity] as number] as const
      expect(ranks[0]).toBeLessThanOrEqual(ranks[1])
      if (ranks[0] !== ranks[1]) continue
      if (a.ageIso === null) {
        expect(b.ageIso, `${a.name} before ${b.name}`).toBeNull()
      } else if (b.ageIso !== null) {
        expect(Date.parse(a.ageIso)).toBeGreaterThanOrEqual(Date.parse(b.ageIso))
      }
      if (a.ageIso === b.ageIso) expect(a.name.localeCompare(b.name)).toBeLessThanOrEqual(0)
    }
  })

  it('leads with the worst, newest problem and ends with stopped containers', async () => {
    const { items } = await apiFor().listAttention({ includeIdle: true })
    expect(items[0]?.severity).toBe('critical')
    expect(items.at(-1)?.severity).toBe('idle')
    const lastCritical = items.map((item) => item.severity).lastIndexOf('critical')
    const firstWarning = items.findIndex((item) => item.severity === 'warning')
    expect(lastCritical).toBeLessThan(firstWarning)
  })

  const detailOf = async (name: string, kind?: AttentionItem['kind']) => {
    const { items } = await apiFor().listAttention({ includeIdle: true })
    return items.find((item) => item.name === name && (kind ? item.kind === kind : true))
  }

  it('describes an offline server with its last heartbeat', async () => {
    expect(await detailOf('pir-fs-01')).toMatchObject({
      kind: 'server',
      severity: 'critical',
      stateLabel: 'OFFLINE',
      detail: 'offline · last heartbeat 14m ago',
      ageBasis: 'last-seen',
      siteName: 'Piraeus Depot',
      customerName: 'Meridian Logistics',
    })
  })

  it('describes resource problems by their worst metric, with no age', async () => {
    expect(await detailOf('ath-db-01')).toMatchObject({
      severity: 'warning',
      stateLabel: 'DISK',
      detail: 'disk 91% · warn at 80',
      ageIso: null,
      ageBasis: null,
    })
    expect(await detailOf('hc-bkp-01')).toMatchObject({
      stateLabel: 'HIGH MEM',
      detail: 'memory 93% · warn at 80',
    })
    expect(await detailOf('fra-web-02', 'server')).toMatchObject({
      stateLabel: 'HIGH CPU',
      detail: 'cpu 85% · warn at 80',
    })
  })

  it('describes containers by state and host, using only ingested fields', async () => {
    expect(await detailOf('pgbouncer')).toMatchObject({
      severity: 'critical',
      stateLabel: 'UNHEALTHY',
      detail: 'unhealthy · on ath-db-01',
      hostName: 'ath-db-01',
      ageBasis: 'last-seen',
    })
    expect(await detailOf('queue-worker')).toMatchObject({
      severity: 'warning',
      stateLabel: 'RESTARTING',
      detail: 'restarting · on fra-web-02',
    })
    expect(await detailOf('receipt-printer')).toMatchObject({
      stateLabel: 'DEAD',
      detail: 'dead · on muc-pos-02',
    })
    expect(await detailOf('samba')).toMatchObject({
      severity: 'unknown',
      stateLabel: 'UNKNOWN',
      detail: 'state unknown · on pir-fs-01',
    })
    expect(await detailOf('certbot')).toMatchObject({
      severity: 'idle',
      stateLabel: 'STOPPED',
      detail: 'exited · on fra-web-01',
    })
    expect(await detailOf('runner')).toMatchObject({
      stateLabel: 'PAUSED',
      detail: 'paused · on core-git-01',
    })
    expect(await detailOf('migrate')).toMatchObject({ stateLabel: 'CREATED' })
    expect(await detailOf('loki')).toMatchObject({ stateLabel: 'STARTING', severity: 'idle' })
  })

  it('describes targets by what failed, dated from the first failed probe', async () => {
    const gateway = await detailOf('pir-gateway')
    expect(gateway).toMatchObject({
      severity: 'critical',
      stateLabel: 'DOWN',
      ageBasis: 'failing-since',
    })
    expect(gateway?.detail).toMatch(/^host unreachable · \d+ failed probes$/)
    const vpn = await detailOf('pir-vpn')
    expect(vpn?.detail).toMatch(/^timeout · \d+ failed probes$/)
    expect(Date.parse(vpn?.ageIso as string)).toBeLessThan(NOW - 10 * 60_000)
    expect(await detailOf('muc-vpn')).toMatchObject({
      severity: 'warning',
      stateLabel: 'FAILING',
      detail: 'connection refused · 2 failed probes',
      ageBasis: 'failing-since',
    })
  })

  it('describes loss and latency without a made-up start', async () => {
    const loss = await detailOf('fra-isp-a')
    expect(loss?.detail).toMatch(/^loss 6% · \d+ ms$/)
    expect(loss).toMatchObject({ stateLabel: 'DEGRADED', ageIso: null, ageBasis: null })
    expect((await detailOf('muc-cdn'))?.detail).toMatch(/^latency 2\d\d ms · warn at 150$/)
    expect((await detailOf('hc-annex-lte'))?.detail).toMatch(/^loss 3% · \d+ ms$/)
  })

  it('says "never reported" for a server that has never reported', async () => {
    expect(await detailOf('core-ci-01')).toMatchObject({
      severity: 'unknown',
      stateLabel: 'UNKNOWN',
      detail: 'never reported',
      ageIso: null,
      ageBasis: null,
    })
  })

  it('describes unobserved targets', async () => {
    const { items } = await apiFor('partial').listAttention()
    expect(items.find((item) => item.name === 'core-git-https')?.detail).toBe('never reported')
    expect(items.find((item) => item.name === 'hc-portal')?.detail).toBe(
      'no recent measurement · last probe 3h ago',
    )
  })

  it('omits site names for entities that belong to no site', () => {
    const { fleet } = buildEstate('story', { now: NOW, anchor: NOW })
    const dns = fleet.targets.find((target) => target.name === 'public-dns')
    if (!dns) throw new Error('fixture missing')
    Object.assign(dns, {
      status: 'down',
      failingSince: dns.lastProbeAt,
      consecutiveFailures: 5,
      failureReason: 'timeout',
    })
    const item = listAttention(fleet, NOW, false).items.find((entry) => entry.name === 'public-dns')
    expect(item).toBeDefined()
    expect(item).not.toHaveProperty('siteName')
    expect(item).not.toHaveProperty('customerName')
  })
})

describe('fleet load', () => {
  const api = apiFor()
  const metrics: LoadMetric[] = ['cpu', 'memory', 'disk']

  it.each(metrics)('ranks the top 8 by %s, ties by name', async (metric) => {
    const { rows } = await api.getFleetLoad({ metric })
    expect(rows).toHaveLength(8)
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1]
      const b = rows[i]
      expect(a!.percent).toBeGreaterThanOrEqual(b!.percent)
      if (a!.percent === b!.percent) expect(a!.name.localeCompare(b!.name)).toBeLessThan(0)
    }
  })

  it('surfaces the story servers on their tab', async () => {
    const top = async (metric: LoadMetric) => (await api.getFleetLoad({ metric })).rows[0]
    expect(await top('cpu')).toMatchObject({ name: 'fra-web-02' })
    expect(await top('memory')).toMatchObject({ name: 'hc-bkp-01' })
    expect(await top('disk')).toMatchObject({ name: 'ath-db-01' })
    expect((await top('disk'))?.percent).toBeGreaterThan(90)
  })

  it('names the servers without a usable sample', async () => {
    const { rows, excluded } = await api.getFleetLoad({ metric: 'cpu', limit: 50 })
    expect(excluded).toEqual(['core-ci-01', 'pir-fs-01'])
    expect(rows).toHaveLength(14)
    expect(rows.some((row) => excluded.includes(row.name))).toBe(false)
  })

  it('honors the limit', async () => {
    expect((await api.getFleetLoad({ metric: 'cpu', limit: 3 })).rows).toHaveLength(3)
  })

  it('agrees with the health classification of the same servers', async () => {
    const [{ rows }, { items }] = await Promise.all([
      api.getFleetLoad({ metric: 'cpu', limit: 50 }),
      api.listAttention(),
    ])
    const hot = new Set(rows.filter((row) => row.percent >= 80).map((row) => row.name))
    const flagged = new Set(
      items
        .filter((item) => item.kind === 'server' && item.stateLabel === 'HIGH CPU')
        .map((i) => i.name),
    )
    expect(flagged).toEqual(hot)
  })

  it('stamps each row with the sample it came from', async () => {
    const { rows } = await api.getFleetLoad({ metric: 'cpu' })
    for (const row of rows) expect(Date.parse(row.collectedAt)).toBeLessThanOrEqual(NOW)
  })
})

describe('health breakdown by site', () => {
  it('lists the worst site first: critical count, then warning count, then name', async () => {
    const { sites } = await apiFor().getHealthBreakdown()
    const tally = (status: HealthStatus, entities: { status: HealthStatus }[]) =>
      entities.filter((entity) => entity.status === status).length
    for (let i = 1; i < sites.length; i += 1) {
      const a = sites[i - 1]!.entities
      const b = sites[i]!.entities
      const key = (e: typeof a) => [tally('critical', e), tally('warning', e)]
      const [ac, aw] = key(a)
      const [bc, bw] = key(b)
      expect(ac! > bc! || (ac === bc && aw! >= bw!)).toBe(true)
    }
    expect(sites[0]?.siteName).toBe('Piraeus Depot')
    expect(sites[0]?.customerName).toBe('Meridian Logistics')
  })

  it('lists each site worst entity first, and names containers by host', async () => {
    const { sites } = await apiFor().getHealthBreakdown()
    const order: Record<HealthStatus, number> = {
      critical: 0,
      warning: 1,
      unknown: 2,
      idle: 3,
      healthy: 4,
    }
    for (const { entities } of sites) {
      for (let i = 1; i < entities.length; i += 1) {
        expect(order[entities[i - 1]!.status]).toBeLessThanOrEqual(order[entities[i]!.status])
      }
    }
    const athens = sites.find((entry) => entry.siteName === 'Athens DC')
    expect(athens?.entities.find((e) => e.kind === 'container')?.name).toMatch(/@ath-/)
  })
})

describe('entity index details', () => {
  it('shows what a person would search by', async () => {
    const { items } = await apiFor().getEntityIndex()
    const find = (id: string) => items.find((item) => item.id === id)
    expect(find('srv-pir-fs-01')).toMatchObject({
      kind: 'server',
      detail: 'pir-fs-01.internal 10.30.1.20',
      status: 'critical',
      customerName: 'Meridian Logistics',
      siteName: 'Piraeus Depot',
    })
    expect(find('ctr-ath-db-01-postgres')).toMatchObject({
      kind: 'container',
      detail: 'postgres:16.4 on ath-db-01',
      siteName: 'Athens DC',
    })
    expect(find('tgt-ath-api')).toMatchObject({
      kind: 'target',
      detail: 'api.meridian.example:443',
    })
    expect(find('tgt-ath-gateway')).toMatchObject({ detail: '10.20.0.1' })
    expect(find('tgt-public-dns')).not.toHaveProperty('siteName')
    expect(find('dev-pir-sw1')).toMatchObject({
      kind: 'device',
      detail: '10.30.0.3',
      status: 'unknown',
    })
    expect(find('site-pir-depot')).toMatchObject({
      kind: 'site',
      status: 'critical',
      customerName: 'Meridian Logistics',
    })
    expect(find('cus-meridian')).toMatchObject({
      kind: 'customer',
      name: 'Meridian Logistics',
      status: 'critical',
    })
    expect(find('cus-internal')?.status).toBe('unknown')
  })
})

describe('offline flags', () => {
  const NORMAL = apiFor()

  it('marks only the servers whose agent stopped reporting', async () => {
    const [{ items: servers }, { items: attention }, { items: index }, { sites }] =
      await Promise.all([
        NORMAL.listServers(),
        NORMAL.listAttention({ includeIdle: true }),
        NORMAL.getEntityIndex(),
        NORMAL.getHealthBreakdown(),
      ])
    const stopped = servers
      .filter((item) => item.server.status === 'offline')
      .map((item) => item.server.id)
    expect(stopped).toEqual(['srv-pir-fs-01'])

    const flagged = <T extends { id: string; offline?: boolean }>(rows: T[]) =>
      rows.filter((row) => row.offline).map((row) => row.id)
    expect(flagged(attention)).toEqual(stopped)
    expect(flagged(index)).toEqual(stopped)
    expect(flagged(sites.flatMap((entry) => entry.entities))).toEqual(stopped)
    // Nothing that is not a server is ever flagged: not a container, target, device, site or customer.
    expect(attention.filter((item) => item.offline).every((item) => item.kind === 'server')).toBe(
      true,
    )
    expect(index.filter((item) => item.offline).every((item) => item.kind === 'server')).toBe(true)
  })

  it('leaves a flagged server critical everywhere that decides', async () => {
    const { items: attention } = await NORMAL.listAttention({ includeIdle: true })
    expect(attention.find((item) => item.id === 'srv-pir-fs-01')).toMatchObject({
      severity: 'critical',
      offline: true,
    })
    const { items: index } = await NORMAL.getEntityIndex()
    expect(index.find((item) => item.id === 'srv-pir-fs-01')).toMatchObject({
      status: 'critical',
      offline: true,
    })
    const { items: list } = await NORMAL.listServers()
    expect(list.find((item) => item.server.id === 'srv-pir-fs-01')?.health).toBe('critical')
  })

  it('notes the offline members in the server counts only, inside critical', async () => {
    const summary = await NORMAL.getOverviewSummary()
    expect(summary.servers.counts.offline).toBe(1)
    expect(summary.servers.counts.critical).toBeGreaterThanOrEqual(1)
    expect(summary.containers.counts).not.toHaveProperty('offline')
    expect(summary.targets.counts).not.toHaveProperty('offline')

    const { domains } = await NORMAL.getHealthBreakdown()
    const byDomain = Object.fromEntries(domains.map((entry) => [entry.domain, entry.counts]))
    expect(byDomain.servers?.offline).toBe(1)
    expect(byDomain.containers).not.toHaveProperty('offline')
    expect(byDomain.targets).not.toHaveProperty('offline')
    expect(byDomain.snmp).not.toHaveProperty('offline')
  })

  it('sets nothing where no server is offline', async () => {
    const healthy = apiFor('healthy')
    const { servers } = await healthy.getOverviewSummary()
    expect(servers.counts).not.toHaveProperty('offline')
    const { items } = await healthy.listAttention({ includeIdle: true })
    expect(items.every((item) => !('offline' in item))).toBe(true)
    const { sites } = await healthy.getHealthBreakdown()
    expect(sites.flatMap((entry) => entry.entities).every((entity) => !('offline' in entity))).toBe(
      true,
    )
  })

  it('follows the scope: another site has no offline server to note', async () => {
    const scope = site('site-fra-dc')
    const summary = await NORMAL.getOverviewSummary({ scope })
    expect(summary.servers.counts).not.toHaveProperty('offline')
    const { items } = await NORMAL.listAttention({ scope, includeIdle: true })
    expect(items.some((item) => item.offline)).toBe(false)
  })

  it('keeps the totals: offline never changes the health counts', async () => {
    const summary = await NORMAL.getOverviewSummary()
    expect(sum(summary.servers.counts)).toBe(summary.servers.total)
    expect(summary.servers.counts.offline ?? 0).toBeLessThanOrEqual(summary.servers.counts.critical)
  })
})
