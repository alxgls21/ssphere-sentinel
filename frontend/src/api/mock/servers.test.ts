import { describe, expect, it } from 'vitest'
import { ApiError } from '../errors'
import { createMockApi } from './client'

const NOW = Date.parse('2026-10-12T14:00:00Z')
const api = (scenario: Parameters<typeof createMockApi>[0] = {}) =>
  createMockApi({ now: () => NOW, delayMs: 0, ...scenario })

describe('listServers', () => {
  it('lists the fleet with health, place and container counts, agreeing with the Overview', async () => {
    const mock = api()
    const [list, summary] = await Promise.all([mock.listServers(), mock.getOverviewSummary()])
    expect(list.items).toHaveLength(summary.servers.total)
    const piraeus = list.items.find((item) => item.server.name === 'pir-fs-01')
    expect(piraeus).toMatchObject({
      health: 'critical',
      siteName: 'Piraeus Depot',
      customerName: 'Meridian Logistics',
    })
    expect(piraeus?.server.status).toBe('offline')
  })

  it('follows the scope', async () => {
    const list = await api().listServers({
      scope: { customerId: 'cus-meridian', siteId: null },
    })
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.every((item) => item.customerName === 'Meridian Logistics')).toBe(true)
  })

  it('is empty when nothing is monitored', async () => {
    expect((await api({ scenario: 'empty' }).listServers()).items).toEqual([])
  })

  it('fails like every other method in the error scenario', async () => {
    await expect(api({ scenario: 'error' }).listServers()).rejects.toBeInstanceOf(ApiError)
  })
})

describe('getServer', () => {
  it('returns the server with its containers, observed through the same classifier as the Docker counts', async () => {
    const mock = api()
    const detail = await mock.getServer('srv-ath-app-01')
    expect(detail.item.server.name).toBe('ath-app-01')
    expect(detail.containers.length).toBe(detail.item.containers.total)
    expect(detail.containers.find((c) => c.container.name === 'api')?.status).toBe('critical')
  })

  it('answers 404 for an unknown id', async () => {
    await expect(api().getServer('srv-nope')).rejects.toMatchObject({ status: 404 })
  })

  it('cannot observe the containers of an offline host', async () => {
    const detail = await api().getServer('srv-pir-fs-01')
    expect(detail.containers.length).toBeGreaterThan(0)
    expect(detail.containers.every((c) => c.status === 'unknown')).toBe(true)
  })
})

describe('getServerSeries', () => {
  it('ends where the list says: the newest sample is the latest reading', async () => {
    const mock = api()
    const [{ item }, series] = await Promise.all([
      mock.getServer('srv-ath-db-01'),
      mock.getServerSeries({ serverId: 'srv-ath-db-01', range: '1h' }),
    ])
    expect(series.t).toHaveLength(60)
    const disk = series.disk.at(-1) as number
    expect(Math.abs(disk - (item.server.telemetry?.diskPercent ?? 0))).toBeLessThan(0.5)
    // Disk only grows.
    const values = series.disk.filter((value): value is number => value !== null)
    expect(values[0]).toBeLessThanOrEqual(values.at(-1) as number)
  })

  it('is deterministic for a clock and shifts with it', async () => {
    const first = await api().getServerSeries({ serverId: 'srv-ath-app-01', range: '6h' })
    const again = await api().getServerSeries({ serverId: 'srv-ath-app-01', range: '6h' })
    expect(again).toEqual(first)
    expect(first.t).toHaveLength(72)
  })

  it('stops at the last heartbeat of an offline host', async () => {
    const series = await api().getServerSeries({ serverId: 'srv-pir-fs-01', range: '1h' })
    expect(series.cpu.at(-1)).toBeNull()
    expect(series.cpu.some((value) => value !== null)).toBe(true)
  })

  it('has no history for a server that never reported', async () => {
    const mock = api({ scenario: 'partial' })
    const never = (await mock.listServers()).items.find((item) => item.server.telemetry === null)
    expect(never).toBeDefined()
    const series = await mock.getServerSeries({ serverId: never!.server.id, range: '1h' })
    expect(series.t).toEqual([])
  })
})
