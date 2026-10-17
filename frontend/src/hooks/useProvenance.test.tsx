import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiContext } from '@/api/context'
import { registryOverrides } from '@/config/testing'
import { createTestApi } from '@/test/render'
import { useProvenance } from './useProvenance'

const overrides = registryOverrides()
afterEach(overrides.restore)

const wrapper = ({ children }: { children: ReactNode }) => (
  <ApiContext.Provider value={createTestApi()}>{children}</ApiContext.Provider>
)
const provenance = (features: Parameters<typeof useProvenance>[0]) =>
  renderHook(() => useProvenance(features), { wrapper }).result.current

describe('useProvenance', () => {
  it('is not a placeholder for a feature the backend supports but the console does not read yet', () => {
    expect(provenance('servers')).toMatchObject({
      planned: false,
      availability: null,
      provenance: 'mock',
    })
  })

  it('is PLANNED when every feature behind it is unsupported', () => {
    expect(provenance('alerts')).toMatchObject({ planned: true, availability: 'planned' })
    expect(provenance(['alerts', 'events'])).toMatchObject({
      planned: true,
      availability: 'planned',
    })
  })

  it('says NOT CONNECTED, not PLANNED and not NEEDS SETUP, for SNMP: stored, but not served to the console', () => {
    const result = provenance('snmp')
    expect(result).toMatchObject({ planned: true, availability: 'not-connected' })
    expect(result.note).toMatch(/configuring SNMP does not make data appear in this console/)
  })

  it('is a placeholder only when nothing behind it can show real data', () => {
    expect(provenance(['servers', 'snmp'])).toMatchObject({ planned: false, availability: null })
    expect(provenance(['snmp', 'alerts'])).toMatchObject({
      planned: true,
      availability: 'not-connected',
    })
  })

  it('is not a placeholder for no features at all', () => {
    expect(provenance([])).toMatchObject({ planned: false, availability: null })
  })

  describe('what the content may claim', () => {
    const withSource = (
      source: 'http' | 'mock' | undefined,
      features: Parameters<typeof useProvenance>[0],
    ) =>
      renderHook(() => useProvenance(features), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ApiContext.Provider
            value={{ ...createTestApi(), source } as ReturnType<typeof createTestApi>}
          >
            {children}
          </ApiContext.Provider>
        ),
      }).result.current.provenance

    it('is never live from the adapter alone', () => {
      expect(withSource('http', 'customers')).toBe('mock')
      expect(withSource('http', ['servers', 'customers', 'network'])).toBe('mock')
      // Even the servers, which the console reads, are not live where demo data is mixed in.
      expect(withSource('http', ['servers', 'customers'])).toBe('mock')
    })

    it('is live only when every feature behind it is connected and real', () => {
      expect(withSource('http', 'servers')).toBe('live')
      expect(withSource('http', ['servers', 'overview'])).toBe('live')
      expect(withSource('http', ['servers', 'customers'])).toBe('mock')
      overrides.set('customers', { connected: true })
      expect(withSource('http', ['servers', 'customers'])).toBe('live')
    })

    it('is mock under a mock adapter, whatever the registry says', () => {
      overrides.set('servers', { connected: true })
      expect(withSource('mock', 'servers')).toBe('mock')
    })

    it('is unknown without a source, without features, or for an unknown feature', () => {
      overrides.set('servers', { connected: true })
      expect(withSource(undefined, 'servers')).toBe('unknown')
      expect(withSource('http', [])).toBe('unknown')
      expect(withSource('http', 'not-a-feature' as never)).toBe('unknown')
    })
  })
})
