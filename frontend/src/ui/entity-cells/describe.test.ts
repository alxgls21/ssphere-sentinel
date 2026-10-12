import { describe, expect, it } from 'vitest'
import type { EntityKind, HealthStatus, SiteEntity } from '@/api/types'
import { describeEntities } from './describe'

const entity = (name: string, status: HealthStatus, kind: EntityKind = 'server'): SiteEntity => ({
  id: name,
  kind,
  name,
  status,
})

const many = (count: number, status: HealthStatus, prefix: string) =>
  Array.from({ length: count }, (_, index) => entity(`${prefix}-${index + 1}`, status))

describe('describeEntities', () => {
  it('names the entities that need a look, worst first, and only counts the rest', () => {
    const entities = [
      ...many(15, 'healthy', 'ok'),
      entity('api-02', 'warning'),
      entity('edge-gw-02', 'critical'),
      entity('acme-vpn:443', 'critical', 'target'),
    ]
    expect(describeEntities('Acme / Athens-DC', entities)).toBe(
      'Acme / Athens-DC: 2 critical (edge-gw-02, acme-vpn:443), 1 warning (api-02), 15 ok',
    )
  })

  it('names unknown entities too, but not idle ones', () => {
    const entities = [entity('web-01', 'unknown'), entity('job-1', 'idle'), entity('job-2', 'idle')]
    expect(describeEntities('Site', entities)).toBe('Site: 1 unknown (web-01), 2 idle')
  })

  it('does not depend on the order entities arrive in', () => {
    const entities = [entity('a', 'healthy'), entity('b', 'critical'), entity('c', 'warning')]
    expect(describeEntities('Site', entities)).toBe('Site: 1 critical (b), 1 warning (c), 1 ok')
  })

  it('lists three names per status, then how many more', () => {
    expect(describeEntities('Site', many(5, 'critical', 'srv'))).toBe(
      'Site: 5 critical (srv-1, srv-2, srv-3, +2 more)',
    )
    expect(describeEntities('Site', many(3, 'critical', 'srv'))).toBe(
      'Site: 3 critical (srv-1, srv-2, srv-3)',
    )
  })

  it('clips absurdly long names (they are free text from the backend)', () => {
    const label = describeEntities('Site', [entity('x'.repeat(200), 'critical')])
    expect(label).toBe(`Site: 1 critical (${'x'.repeat(31)}…)`)
  })

  it('says so when there is nothing to describe', () => {
    expect(describeEntities('Acme / Athens-DC', [])).toBe('Acme / Athens-DC: no entities')
  })

  it('describes an all-healthy site with counts only', () => {
    expect(describeEntities('Site', many(4, 'healthy', 'ok'))).toBe('Site: 4 ok')
  })
})
