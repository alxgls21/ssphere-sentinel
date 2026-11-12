import { describe, expect, it } from 'vitest'
import type { InventoryDevice } from '@/api/types'
import {
  NEW_DEVICE,
  deviceDraft,
  deviceInput,
  devicePatch,
  devicesRequest,
  parseDevicesQuery,
  snmpText,
  validateDevice,
  writeDevicesQuery,
} from './devicesModel'

const device: InventoryDevice = {
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
  agent: {
    id: 'a1',
    name: 'poller',
    status: 'online',
    lastSeenAt: null,
    serverId: 's1',
    serverName: 'poller-host',
  },
  snmp: { version: '3', port: 161, pollIntervalSeconds: 300, timeoutSeconds: 5, retries: 1 },
  hasHistory: false,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
}

describe('the devices list query', () => {
  it('reads and writes the search, the SNMP filter, the sort and the page', () => {
    expect(parseDevicesQuery(new URLSearchParams('snmp=none&sort=created'))).toEqual({
      q: '',
      snmp: 'none',
      sort: 'created',
      dir: 'desc',
      page: 1,
    })
    expect(parseDevicesQuery(new URLSearchParams('snmp=v3'))).toMatchObject({ snmp: 'all' })
    expect(
      Object.fromEntries(
        writeDevicesQuery(new URLSearchParams(''), {
          q: '',
          snmp: 'configured',
          sort: 'name',
          dir: 'asc',
          page: 2,
        }),
      ),
    ).toEqual({ snmp: 'configured', page: '2' })
    expect(devicesRequest({ q: '', snmp: 'all', sort: 'type', dir: 'asc', page: 1 }, 'sw')).toEqual(
      { q: 'sw', snmp: 'all', sort: 'type', dir: 'asc', page: 1, pageSize: 50 },
    )
  })
})

describe('the device form', () => {
  it('starts from the device as it is, the SNMP block on and the profile blank (it is never read back)', () => {
    expect(deviceDraft(device)).toEqual({
      name: 'core-sw',
      type: 'switch',
      address: 'core.example.net',
      enabled: true,
      description: '',
      siteId: 'site-1',
      agentId: 'a1',
      snmp: true,
      version: '3',
      port: '161',
      credentialProfile: '',
      pollIntervalSeconds: '300',
      timeoutSeconds: '5',
      retries: '1',
    })
    expect(deviceDraft({ ...device, snmp: null, siteId: null, agent: null })).toMatchObject({
      snmp: false,
      siteId: '',
      agentId: '',
      version: '3',
      port: '161',
    })
  })

  it('requires a profile for a new SNMP configuration and keeps the one a device has', () => {
    const polled = { ...NEW_DEVICE, name: 'sw', address: '10.0.0.2', snmp: true }
    expect(validateDevice(polled, false)).toEqual({
      'snmp.credentialProfile': [
        'Required: the name of a profile in the agent’s credentials file.',
      ],
    })
    expect(validateDevice(polled, true)).toEqual({})
    expect(validateDevice({ ...polled, credentialProfile: 'bad profile' }, true)).toEqual({
      'snmp.credentialProfile': ["Use letters, digits, '.', '_' and '-'."],
    })
  })

  it('checks the bounds and the timing rule of the SNMP block, and nothing of it when the device is not polled', () => {
    const polled = {
      ...NEW_DEVICE,
      name: 'sw',
      address: '10.0.0.2',
      snmp: true,
      credentialProfile: 'lab',
    }
    expect(validateDevice({ ...polled, port: '0', retries: '6' }, false)).toEqual({
      'snmp.port': ['Expected a whole number from 1 to 65535.'],
      'snmp.retries': ['Expected a whole number from 0 to 5.'],
    })
    expect(
      validateDevice(
        { ...polled, pollIntervalSeconds: '30', timeoutSeconds: '10', retries: '2' },
        false,
      ),
    ).toEqual({
      'snmp.nonField': ['timeout × (retries + 1) must be shorter than the poll interval.'],
    })
    expect(validateDevice({ ...polled, snmp: false, port: 'x' }, false)).toEqual({})
    expect(validateDevice({ ...NEW_DEVICE, name: ' ', address: 'a b' }, false)).toEqual({
      name: ['Required.'],
      address: ['Expected a host name or an IP address.'],
    })
  })

  it('sends the SNMP block with the profile only when typed, or null when the device is not polled', () => {
    expect(deviceInput({ ...NEW_DEVICE, name: ' sw ', address: '10.0.0.2' })).toEqual({
      name: 'sw',
      address: '10.0.0.2',
      type: 'other',
      enabled: true,
      description: '',
      siteId: null,
      agentId: null,
      snmp: null,
    })
    expect(
      deviceInput({
        ...NEW_DEVICE,
        name: 'sw',
        address: '10.0.0.2',
        snmp: true,
        credentialProfile: ' lab ',
      }).snmp,
    ).toEqual({
      version: '3',
      port: 161,
      credentialProfile: 'lab',
      pollIntervalSeconds: 300,
      timeoutSeconds: 5,
      retries: 1,
    })
  })

  it('sends only what changed: a device field, an SNMP key, a profile typed, or the block removed', () => {
    expect(devicePatch(deviceDraft(device), device)).toBeNull()
    expect(devicePatch({ ...deviceDraft(device), enabled: false }, device)).toEqual({
      enabled: false,
    })
    expect(devicePatch({ ...deviceDraft(device), port: '1161' }, device)).toEqual({
      snmp: { port: 1161 },
    })
    expect(devicePatch({ ...deviceDraft(device), credentialProfile: 'new' }, device)).toEqual({
      snmp: { credentialProfile: 'new' },
    })
    expect(devicePatch({ ...deviceDraft(device), snmp: false }, device)).toEqual({ snmp: null })
    const unpolled = { ...device, snmp: null }
    expect(
      devicePatch({ ...deviceDraft(unpolled), snmp: true, credentialProfile: 'lab' }, unpolled),
    ).toEqual({
      snmp: {
        version: '3',
        port: 161,
        credentialProfile: 'lab',
        pollIntervalSeconds: 300,
        timeoutSeconds: 5,
        retries: 1,
      },
    })
    expect(devicePatch({ ...deviceDraft(unpolled), snmp: false, port: '9' }, unpolled)).toBeNull()
  })

  it('says how a device is polled', () => {
    expect(snmpText(device)).toBe('SNMPv3 · port 161')
    expect(snmpText({ ...device, snmp: null })).toBe('Not polled')
  })
})
