import { describe, expect, it, vi } from 'vitest'
import {
  createInventoryDevice,
  deleteInventoryDevice,
  getInventoryDevice,
  listInventoryDevices,
  parseInventoryDevice,
  updateInventoryDevice,
} from './inventory'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (device_config.py). */
const agent = {
  id: 'a1',
  name: 'poller',
  status: 'online',
  lastSeenAt: '2026-10-17T10:00:00.000Z',
  serverId: 's1',
  serverName: 'poller-host',
}
const device = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  name: 'core-sw',
  type: 'switch',
  address: 'core.example.net',
  enabled: true,
  description: '',
  siteId: 'site-1',
  customerName: 'Meridian',
  siteName: 'Athens DC',
  agentAssigned: true,
  agent,
  snmp: { version: '3', port: 161, pollIntervalSeconds: 300, timeoutSeconds: 5, retries: 1 },
  hasHistory: false,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  ...over,
})
const list = (items: unknown[]) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
  scopeTotal: 3,
})
const detail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  item: device(over),
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  const post = vi.fn(async () => answer)
  const patch = vi.fn(async () => answer)
  const del = vi.fn(async () => answer)
  return { get, post, patch, delete: del } as unknown as Transport & {
    get: typeof get
    post: typeof post
    patch: typeof patch
    delete: typeof del
  }
}

describe('the inventory of devices', () => {
  it('lists them with the scope, the search and the filters', async () => {
    const t = transport(list([device()]))
    const result = await listInventoryDevices(t)({
      scope: { customerId: 'c1', siteId: null },
      q: 'core',
      snmp: 'configured',
      sort: 'type',
      dir: 'asc',
    })
    expect(result.items[0]).toMatchObject({ id: 'd1', type: 'switch', snmp: { version: '3' } })
    expect(t.get).toHaveBeenCalledWith('inventory/devices/', {
      signal: undefined,
      query: {
        customer: 'c1',
        site: undefined,
        q: 'core',
        snmp: 'configured',
        sort: 'type',
        dir: 'asc',
        page: undefined,
        pageSize: undefined,
      },
    })
  })

  it('reads a device without SNMP, without a site, and with a hidden agent', () => {
    const parsed = parseInventoryDevice(
      device({
        snmp: null,
        siteId: null,
        customerName: undefined,
        siteName: undefined,
        agent: null,
      }),
    )
    expect(parsed.snmp).toBeNull()
    expect(parsed.siteId).toBeNull()
    expect(parsed).not.toHaveProperty('customerName')
    expect(parsed.agent).toBeNull()
    expect(parsed.agentAssigned).toBe(true)
  })

  it('never carries a credential profile, even if an answer held one', () => {
    const parsed = parseInventoryDevice(
      device({
        snmp: {
          version: '2c',
          port: 161,
          pollIntervalSeconds: 60,
          timeoutSeconds: 5,
          retries: 1,
          credentialProfile: 'secret',
        },
      }),
    )
    expect(JSON.stringify(parsed)).not.toMatch(/secret|credential/)
  })

  it('creates a device with its SNMP block named field by field, and the profile only when typed', async () => {
    const t = transport(detail())
    await createInventoryDevice(t)({
      name: 'core-sw',
      address: 'core.example.net',
      type: 'switch',
      siteId: 'site-1',
      snmp: { version: '3', credentialProfile: 'lab', retries: 2 },
    })
    expect(t.post).toHaveBeenCalledWith(
      'inventory/devices/',
      {
        name: 'core-sw',
        address: 'core.example.net',
        type: 'switch',
        siteId: 'site-1',
        snmp: { version: '3', credentialProfile: 'lab', retries: 2 },
      },
      { signal: undefined },
    )
    await updateInventoryDevice(t)('d1', { snmp: { port: 1161 } })
    expect(t.patch).toHaveBeenCalledWith(
      'inventory/devices/d1/',
      { snmp: { port: 1161 } },
      { signal: undefined },
    )
    await updateInventoryDevice(t)('d1', { snmp: null, enabled: false })
    expect(t.patch).toHaveBeenLastCalledWith(
      'inventory/devices/d1/',
      { enabled: false, snmp: null },
      { signal: undefined },
    )
  })

  it('reads one and deletes one, encoding the id', async () => {
    const t = transport(detail())
    expect((await getInventoryDevice(t)('a b')).item.name).toBe('core-sw')
    expect(t.get).toHaveBeenCalledWith('inventory/devices/a%20b/', { signal: undefined })
    const gone = transport({
      generatedAt: '2026-10-17T10:00:05.000Z',
      deleted: { id: 'd1', name: 'core-sw' },
    })
    expect((await deleteInventoryDevice(gone)('d1')).deleted.name).toBe('core-sw')
    expect(gone.delete).toHaveBeenCalledWith('inventory/devices/d1/', { signal: undefined })
  })

  it.each([
    ['an unknown type', device({ type: 'modem' })],
    [
      'an SNMP version it does not know',
      device({
        snmp: { version: '1', port: 161, pollIntervalSeconds: 300, timeoutSeconds: 5, retries: 1 },
      }),
    ],
    [
      'a port of zero',
      device({
        snmp: { version: '3', port: 0, pollIntervalSeconds: 300, timeoutSeconds: 5, retries: 1 },
      }),
    ],
    ['history that is not a flag', device({ hasHistory: 'no' })],
  ])('refuses a device with %s', (_what, raw) => {
    expect(() => parseInventoryDevice(raw)).toThrow(/unexpected answer/)
  })
})
