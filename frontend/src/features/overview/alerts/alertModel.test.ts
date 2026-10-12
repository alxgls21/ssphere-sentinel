import { describe, expect, it } from 'vitest'
import type { Alert } from '@/api/types'
import { rankedAlerts } from './alertModel'

const alert = (id: string, severity: Alert['severity'], since: string): Alert => ({
  id,
  severity,
  state: 'active',
  title: id,
  message: id,
  subject: { kind: 'server', id, name: id },
  rule: 'rule',
  siteId: null,
  since,
})

describe('rankedAlerts', () => {
  it('lists critical before warning, then the newest first', () => {
    const ranked = rankedAlerts([
      alert('w-new', 'warning', '2026-10-12T14:00:00Z'),
      alert('c-old', 'critical', '2026-10-12T10:00:00Z'),
      alert('c-new', 'critical', '2026-10-12T13:00:00Z'),
      alert('w-old', 'warning', '2026-10-12T09:00:00Z'),
    ])
    expect(ranked.map((a) => a.id)).toEqual(['c-new', 'c-old', 'w-new', 'w-old'])
  })

  it('breaks a full tie by id so the order is stable across polls', () => {
    const same = '2026-10-12T14:00:00Z'
    expect(
      rankedAlerts([alert('b', 'critical', same), alert('a', 'critical', same)]).map((a) => a.id),
    ).toEqual(['a', 'b'])
  })

  it('does not mutate its input', () => {
    const input = [
      alert('w', 'warning', '2026-10-12T14:00:00Z'),
      alert('c', 'critical', '2026-10-12T14:00:00Z'),
    ]
    rankedAlerts(input)
    expect(input.map((a) => a.id)).toEqual(['w', 'c'])
  })
})
