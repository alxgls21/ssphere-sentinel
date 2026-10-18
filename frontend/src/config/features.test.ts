import { afterEach, describe, expect, it } from 'vitest'
import {
  AVAILABILITY_WORD,
  AVAILABILITY_WORD_SHORT,
  DATA_FEATURES,
  FEATURES,
  availabilityOf,
  describeAvailability,
  isPlaceholder,
  isPlanned,
  shortfallOf,
  type FeatureId,
} from './features'
import { registryOverrides } from './testing'

const overrides = registryOverrides()
const setFeature = overrides.set
afterEach(overrides.restore)

describe('availabilityOf', () => {
  describe('live needs everything: the console API, the screen reading it, and real data', () => {
    it('is live when all three are present', () => {
      setFeature('servers', { connected: true })
      expect(availabilityOf('servers', 'http')).toBe('live')
      expect(shortfallOf('servers', 'http')).toBeNull()
      expect(isPlanned('servers')).toBe(false)
      expect(isPlaceholder('servers', 'http')).toBe(false)
      expect(describeAvailability('servers', 'http')).toBe('Connected to the console API')
    })

    it('is not live while the screen does not read it, however ready the backend is', () => {
      expect(FEATURES.customers.backend).toBe('console-api')
      expect(availabilityOf('customers', 'http')).toBe('not-connected')
      setFeature('servers', { connected: false })
      expect(availabilityOf('servers', 'http')).toBe('not-connected')
    })

    it('G. is never live on demo data, even for a feature marked connected', () => {
      setFeature('servers', { connected: true })
      expect(availabilityOf('servers', 'mock')).toBe('not-connected')
    })

    it('fails conservatively when the data source is not given', () => {
      setFeature('servers', { connected: true })
      expect(availabilityOf('servers')).toBe('not-connected')
    })

    it('F. is never live for data the backend only stores, even if an entry claims it is connected', () => {
      setFeature('network-overview', { connected: true })
      expect(FEATURES['network-overview'].backend).toBe('stored')
      expect(availabilityOf('network-overview', 'http')).toBe('not-connected')
      expect(describeAvailability('network-overview', 'http')).toBe(
        'Stored by the backend; the console API does not serve it yet',
      )
    })
  })

  describe('a feature the backend supports but the console does not read yet', () => {
    it.each(['customers'] as const)('%s is not connected', (id) => {
      expect(availabilityOf(id, 'http')).toBe('not-connected')
      expect(shortfallOf(id, 'http')).toBe('not-connected')
      expect(isPlanned(id)).toBe(false)
      // Demo figures stand in for it: no placeholder frame.
      expect(isPlaceholder(id, 'http')).toBe(false)
    })

    it.each(['network-overview'] as const)(
      '%s is not connected, and its panels show a placeholder instead of demo figures',
      (id) => {
        expect(availabilityOf(id, 'http')).toBe('not-connected')
        expect(isPlanned(id)).toBe(false)
        expect(isPlaceholder(id, 'http')).toBe(true)
      },
    )

    it('says whether the console API serves it or only the backend stores it', () => {
      expect(describeAvailability('customers')).toBe(
        'Served by the console API; this screen is not connected to it yet',
      )
      expect(describeAvailability('network-overview')).toBe(
        'Stored by the backend; the console API does not serve it yet',
      )
    })
  })

  describe('SNMP: served by the console API and read by the SNMP screens', () => {
    it('is live over the console API, and never on demo data', () => {
      expect(availabilityOf('snmp', 'http')).toBe('live')
      expect(availabilityOf('snmp', 'mock')).toBe('not-connected')
      expect(isPlanned('snmp')).toBe(false)
      expect(isPlaceholder('snmp', 'http')).toBe(false)
    })

    it('keeps its prerequisites as information: setting them up says nothing about the data', () => {
      expect(FEATURES.snmp.requires).toMatch(/credentials file/)
      expect(FEATURES.snmp.configuration).toBeUndefined()
      setFeature('snmp', { configuration: 'missing' })
      expect(availabilityOf('snmp', 'http')).toBe('needs-configuration')
    })

    it('is what the Overview’s device counts, health and queue read: live with it, no placeholder of its own', () => {
      expect(Object.keys(FEATURES)).not.toContain('snmp-overview')
      expect(FEATURES.overview.note).toMatch(/SNMP devices/)
      expect(FEATURES.snmp.note).toMatch(/Overview/)
    })
  })

  describe('site assignment: served by the console API, read by the screens', () => {
    it('C. is live over the console API, and never on demo data', () => {
      setFeature('site-links', { configuration: 'complete' })
      expect(availabilityOf('site-links', 'http')).toBe('live')
      expect(availabilityOf('site-links', 'mock')).toBe('not-connected')
    })

    it('does not claim that site assignment is missing or that setup is incomplete', () => {
      expect(isPlanned('site-links')).toBe(false)
      expect(FEATURES['site-links'].note).not.toMatch(
        /not implemented|missing|incomplete|no .* link/i,
      )
      expect(FEATURES['site-links'].note).toMatch(
        /supports placing servers and probe targets on a site/,
      )
      expect(FEATURES['site-links'].note).toMatch(/the console API filters by it/)
    })
  })

  describe('configuration', () => {
    it('does not follow from the mere presence of prerequisites', () => {
      setFeature('servers', { connected: true, requires: 'something to set up' })
      expect(availabilityOf('servers', 'http')).toBe('live')
    })

    it('D. unknown configuration is not confirmed missing setup', () => {
      setFeature('servers', { connected: true, requires: 'something', configuration: 'unknown' })
      expect(availabilityOf('servers', 'http')).toBe('live')
      setFeature('servers', { configuration: undefined })
      expect(availabilityOf('servers', 'http')).toBe('live')
    })

    it('E. needs configuration only when it is confirmed missing for an otherwise connected feature', () => {
      setFeature('servers', { connected: true, requires: 'something', configuration: 'missing' })
      expect(availabilityOf('servers', 'http')).toBe('needs-configuration')
      expect(shortfallOf('servers', 'http')).toBe('needs-configuration')
      expect(isPlaceholder('servers', 'http')).toBe(true)
      expect(describeAvailability('servers', 'http')).toBe(
        'Connected to the console API, but its setup is missing',
      )
    })

    it('does not treat confirmed-missing setup as news for a feature that is not connected anyway', () => {
      setFeature('customers', { configuration: 'missing' })
      expect(availabilityOf('customers', 'http')).toBe('not-connected')
    })

    it('treats complete setup like unknown: it adds nothing to what is connected', () => {
      setFeature('servers', { connected: true, configuration: 'complete' })
      expect(availabilityOf('servers', 'http')).toBe('live')
    })
  })

  describe('a feature the backend does not implement', () => {
    it.each(['events'] as const)('%s is planned, whatever the source', (id) => {
      expect(availabilityOf(id, 'http')).toBe('planned')
      expect(availabilityOf(id, 'mock')).toBe('planned')
      expect(isPlanned(id)).toBe(true)
      expect(isPlaceholder(id, 'http')).toBe(true)
      expect(describeAvailability(id)).toBe('Not implemented in the backend')
    })
  })

  describe('a capability that is not known', () => {
    it('is unknown for an entry that says so, and is neither planned nor a placeholder', () => {
      setFeature('network', { backend: 'unknown' })
      expect(availabilityOf('network', 'http')).toBe('unknown')
      expect(shortfallOf('network', 'http')).toBe('unknown')
      expect(isPlanned('network')).toBe(false)
      expect(isPlaceholder('network', 'http')).toBe(false)
      expect(describeAvailability('network')).toMatch(/^Not detected/)
    })

    it('is unknown for a feature this build has no entry for, never assumed live or unsupported', () => {
      const id = 'something-new' as FeatureId
      expect(availabilityOf(id, 'http')).toBe('unknown')
      expect(isPlanned(id)).toBe(false)
      expect(describeAvailability(id, 'http')).toMatch(/^Not detected/)
    })
  })
})

describe('the registry as shipped', () => {
  it('lists as live only what the console reads from the console API: the overview counts, servers, containers and site assignment', () => {
    const live = (Object.keys(FEATURES) as FeatureId[]).filter(
      (id) => availabilityOf(id, 'http') === 'live',
    )
    expect(live).toEqual([
      'overview',
      'servers',
      'docker',
      'network',
      'snmp',
      'topology',
      'alerts',
      'settings',
      'site-links',
    ])
  })

  it('is live nowhere on demo data, whatever is connected', () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      expect(availabilityOf(id, 'mock'), id).not.toBe('live')
    }
  })

  it('reads the overview summary from the console API: live over http, mock on the sample API', () => {
    expect(availabilityOf('overview', 'http')).toBe('live')
    expect(availabilityOf('overview', 'mock')).toBe('not-connected')
    expect(DATA_FEATURES).toContain('overview')
  })

  it('counts as data only the features whose figures a screen shows', () => {
    expect([...DATA_FEATURES].sort()).toEqual([
      'alerts',
      'docker',
      'network',
      'overview',
      'servers',
      'settings',
      'site-links',
      'snmp',
      'topology',
    ])
    for (const id of ['network-overview', 'events'] as const) {
      expect(DATA_FEATURES).not.toContain(id)
    }
  })

  it('does not say simulated figures are on screen for what is not implemented', () => {
    expect(FEATURES.alerts.note).not.toMatch(/simulated|sample|demo/i)
    expect(FEATURES.events.note).not.toMatch(/simulated|sample|demo/i)
  })

  it('never says a feature needs setup: nothing confirms that any setup is missing', () => {
    for (const id of Object.keys(FEATURES) as FeatureId[]) {
      expect(availabilityOf(id, 'http'), id).not.toBe('needs-configuration')
      expect(FEATURES[id].configuration, id).toBeUndefined()
    }
  })

  it('does not tell an operator that a read API is missing where the console API has one', () => {
    for (const id of ['servers', 'docker', 'customers'] as const) {
      expect(FEATURES[id].backend).toBe('console-api')
      expect(FEATURES[id].note, id).not.toMatch(/not available yet|no read api/i)
    }
  })

  it('keeps the planned wording for what really is not implemented', () => {
    expect(FEATURES.events.note).toMatch(/no event log/)
  })

  describe('alerts: served by the console API and read by the Alerts screen', () => {
    it('is live over the console API, and never on demo data', () => {
      expect(FEATURES.alerts.backend).toBe('console-api')
      expect(availabilityOf('alerts', 'http')).toBe('live')
      expect(availabilityOf('alerts', 'mock')).toBe('not-connected')
      expect(isPlanned('alerts')).toBe(false)
      expect(isPlaceholder('alerts', 'http')).toBe(false)
    })

    it('says what it serves, and that the engine must be running for it to have anything', () => {
      expect(FEATURES.alerts.note).toMatch(/incidents the alert engine opens/)
      expect(FEATURES.alerts.requires).toMatch(/alert engine running/)
    })
  })

  it('says the topology draws no physical links and works out no outage impact', () => {
    expect(availabilityOf('topology', 'http')).toBe('live')
    expect(availabilityOf('topology', 'mock')).toBe('not-connected')
    expect(FEATURES.topology.note).toMatch(/no physical links/)
    expect(FEATURES.topology.note).toMatch(/no outage impact/)
  })

  it('gives every feature a one-sentence note', () => {
    for (const info of Object.values(FEATURES)) expect(info.note).toMatch(/\.$/)
  })

  it('has chip words for each state that needs one, and a short form that fits a tile', () => {
    expect(AVAILABILITY_WORD).toEqual({
      planned: 'Planned',
      'needs-configuration': 'Needs setup',
      'not-connected': 'Not connected',
      unknown: 'Unknown',
    })
    expect(AVAILABILITY_WORD_SHORT['not-connected'].length).toBeLessThanOrEqual(
      AVAILABILITY_WORD_SHORT.planned.length,
    )
  })
})
