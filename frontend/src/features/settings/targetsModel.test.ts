import { describe, expect, it } from 'vitest'
import type { TargetConfig } from '@/api/types'
import {
  NEW_TARGET,
  agentEntryText,
  endpointWord,
  parseTargetsQuery,
  targetDraft,
  targetInput,
  targetPatch,
  targetsRequest,
  validateTarget,
  writeTargetsQuery,
} from './targetsModel'

const config: TargetConfig = {
  id: 't1',
  name: 'ath-gateway',
  address: '10.20.0.1',
  protocol: 'icmp',
  port: null,
  enabled: true,
  intervalSeconds: 60,
  timeoutSeconds: 5,
  expectedSlaPercent: 99.9,
  customerLabel: null,
  circuitId: 'CIR-0042',
  siteId: 'site-ath',
  agentAssigned: true,
  agent: {
    id: 'a1',
    name: 'probe',
    status: 'online',
    lastSeenAt: null,
    serverId: 's1',
    serverName: 'host-1',
  },
}

describe('the targets list query', () => {
  it('reads and writes the search, the sort and the page', () => {
    expect(parseTargetsQuery(new URLSearchParams('sort=status'))).toEqual({
      q: '',
      sort: 'status',
      dir: 'desc',
      page: 1,
    })
    expect(parseTargetsQuery(new URLSearchParams('sort=latency'))).toMatchObject({
      sort: 'name',
      dir: 'asc',
    })
    expect(
      Object.fromEntries(
        writeTargetsQuery(new URLSearchParams(''), { q: 'gw', sort: 'name', dir: 'desc', page: 1 }),
      ),
    ).toEqual({ q: 'gw', dir: 'desc' })
    expect(targetsRequest({ q: '', sort: 'name', dir: 'asc', page: 3 }, 'gw')).toEqual({
      q: 'gw',
      sort: 'name',
      dir: 'asc',
      page: 3,
      pageSize: 50,
    })
  })
})

describe('the target form', () => {
  it('starts from the server’s defaults for a new target, and from the target as it is', () => {
    expect(NEW_TARGET).toMatchObject({
      protocol: 'icmp',
      enabled: true,
      intervalSeconds: '60',
      timeoutSeconds: '2',
      expectedSlaPercent: '99.9',
    })
    expect(targetDraft(config)).toEqual({
      name: 'ath-gateway',
      address: '10.20.0.1',
      protocol: 'icmp',
      port: '',
      enabled: true,
      intervalSeconds: '60',
      timeoutSeconds: '5',
      expectedSlaPercent: '99.9',
      customerLabel: '',
      circuitId: 'CIR-0042',
      siteId: 'site-ath',
      agentId: 'a1',
    })
  })

  it('checks what the server would refuse: the name, the address, the port of a TCP target, the bounds', () => {
    expect(validateTarget({ ...NEW_TARGET, name: ' ', address: 'a b' })).toEqual({
      name: ['Required.'],
      address: ['Expected a host name or an IP address.'],
    })
    expect(
      validateTarget({ ...NEW_TARGET, name: 'x', address: '10.0.0.1', protocol: 'tcp' }),
    ).toEqual({
      port: ['A TCP target needs a port.'],
    })
    expect(
      validateTarget({
        ...NEW_TARGET,
        name: 'x',
        address: '10.0.0.1',
        protocol: 'tcp',
        port: '70000',
      }),
    ).toEqual({
      port: ['Expected a whole number from 1 to 65535.'],
    })
    expect(
      validateTarget({
        ...NEW_TARGET,
        name: 'x',
        address: 'h',
        intervalSeconds: '5',
        timeoutSeconds: '31',
        expectedSlaPercent: '100.5',
      }),
    ).toEqual({
      intervalSeconds: ['Expected a whole number from 10 to 86400.'],
      timeoutSeconds: ['Expected a whole number from 1 to 30.'],
      expectedSlaPercent: ['Expected a number from 0 to 100, with at most two decimals.'],
    })
    expect(
      validateTarget({
        ...NEW_TARGET,
        name: 'x',
        address: 'edge.example.net',
        expectedSlaPercent: '99.95',
      }),
    ).toEqual({})
  })

  it('sends a TCP target with its port and an ICMP target with none, and nothings as null', () => {
    expect(
      targetInput({
        ...NEW_TARGET,
        name: ' gw ',
        address: ' 10.0.0.1 ',
        protocol: 'tcp',
        port: ' 443 ',
      }),
    ).toEqual({
      name: 'gw',
      address: '10.0.0.1',
      protocol: 'tcp',
      port: 443,
      enabled: true,
      intervalSeconds: 60,
      timeoutSeconds: 2,
      expectedSlaPercent: 99.9,
      customerLabel: '',
      circuitId: '',
      siteId: null,
      agentId: null,
    })
    expect(targetInput({ ...NEW_TARGET, name: 'gw', address: 'h', port: '443' }).port).toBeNull()
  })

  it('sends only what changed, the protocol always with its port', () => {
    expect(targetPatch(targetDraft(config), config)).toBeNull()
    expect(targetPatch({ ...targetDraft(config), enabled: false }, config)).toEqual({
      enabled: false,
    })
    expect(targetPatch({ ...targetDraft(config), protocol: 'tcp', port: '443' }, config)).toEqual({
      protocol: 'tcp',
      port: 443,
    })
    expect(targetPatch({ ...targetDraft(config), agentId: '', siteId: '' }, config)).toEqual({
      agentId: null,
      siteId: null,
    })
    expect(targetPatch({ ...targetDraft(config), customerLabel: ' Acme ' }, config)).toEqual({
      customerLabel: 'Acme',
    })
  })

  it('writes the agent’s entry as the example file writes it, and names an endpoint', () => {
    const entry = {
      id: 't1',
      name: 'gw',
      hostname_or_ip: '10.0.0.1',
      protocol: 'tcp' as const,
      port: 443,
      enabled: true,
      monitoring_interval_seconds: 60,
      timeout_seconds: 2,
      probe_count: 4,
    }
    expect(agentEntryText(entry)).toBe(JSON.stringify(entry, null, 2))
    expect(agentEntryText(entry)).toContain('"hostname_or_ip": "10.0.0.1"')
    expect(endpointWord({ protocol: 'tcp', port: 443 })).toBe('TCP 443')
    expect(endpointWord({ protocol: 'icmp', port: null })).toBe('ICMP')
  })
})
