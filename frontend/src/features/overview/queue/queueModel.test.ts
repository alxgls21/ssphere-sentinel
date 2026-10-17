import { describe, expect, it } from 'vitest'
import {
  countItems,
  describeUpdates,
  detailLead,
  entityTarget,
  filterItems,
  hasSite,
  isProblem,
  kindLabel,
  newCriticalKeys,
  nextFilter,
  rowCopyText,
  rowKey,
  rowLabel,
  siteLabel,
  spokenAge,
  updatesText,
  type QueueItem,
  type QueueSnapshot,
} from './queueModel'
import { CHECKED_AT, makeItem, minutesAgo, referenceItems, resultOf } from './testing'

const NOW = Date.parse(CHECKED_AT)

/** A row of the reference queue by its entity name. */
function named(name: string): QueueItem {
  const found = referenceItems().find((item) => item.name === name)
  if (!found) throw new Error(`no reference row ${name}`)
  return found
}
const edge = named('edge-gw-02')
const vpn = named('acme-proxy')
const payments = named('payments-api')
const gateway = named('edge-gw-01')
const api02 = named('api-02')

/** The reference queue with one row (by name) patched. */
const patched = (name: string, patch: Partial<QueueItem>): QueueItem[] =>
  referenceItems().map((item) => (item.name === name ? { ...item, ...patch } : item))

const snapshot = (items: QueueItem[], view = 'v'): QueueSnapshot => ({
  ...resultOf(items),
  view,
})

describe('rows', () => {
  it('names the kind: srv for a server, ctr for a container', () => {
    expect(kindLabel(edge)).toBe('srv')
    expect(kindLabel(payments)).toBe('ctr')
    expect(kindLabel(vpn)).toBe('ctr')
    expect(kindLabel(gateway)).toBe('srv')
  })

  it('names a probe target net, and opens it through the Network screen', () => {
    const target = makeItem({ kind: 'target', id: 'tgt-1' })
    expect(kindLabel(target)).toBe('net')
    expect(entityTarget(target)).toEqual({ pathname: '/network', extra: { focus: 'tgt-1' } })
    expect(rowKey(target)).toBe('target:tgt-1')
  })

  it('keys a row by kind and id, so two kinds may reuse an id', () => {
    expect(rowKey(makeItem({ kind: 'server', id: '7' }))).not.toBe(
      rowKey(makeItem({ kind: 'container', id: '7' })),
    )
  })

  it('joins customer and site, and is null when there is neither', () => {
    expect(siteLabel(edge)).toBe('Acme / Athens-DC')
    expect(siteLabel(makeItem({ customerName: 'Acme', siteName: undefined }))).toBe('Acme')
    expect(siteLabel(makeItem({ customerName: undefined, siteName: undefined }))).toBeNull()
    expect(hasSite([makeItem({ customerName: undefined, siteName: undefined })])).toBe(false)
    expect(hasSite(referenceItems())).toBe(true)
  })

  it('keeps the lead phrase of a detail line', () => {
    expect(detailLead('dead · on edge-gw-02')).toBe('dead')
    expect(detailLead('degraded')).toBe('degraded')
  })

  it('treats idle rows as not a problem', () => {
    expect(isProblem(makeItem({ severity: 'idle' }))).toBe(false)
    expect(isProblem(makeItem({ severity: 'unknown' }))).toBe(true)
  })
})

describe('spokenAge', () => {
  const at = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

  it('spells out the unit and pluralises', () => {
    expect(spokenAge(at(2), NOW)).toBe('just now')
    expect(spokenAge(at(42), NOW)).toBe('42 seconds')
    expect(spokenAge(at(60), NOW)).toBe('1 minute')
    expect(spokenAge(at(9 * 60), NOW)).toBe('9 minutes')
    expect(spokenAge(at(3600), NOW)).toBe('1 hour')
    expect(spokenAge(at(2 * 86_400), NOW)).toBe('2 days')
  })

  it('has nothing to say without a timestamp', () => {
    expect(spokenAge(null, NOW)).toBeNull()
    expect(spokenAge('not a date', NOW)).toBeNull()
  })
})

describe('rowLabel', () => {
  it('reads the whole row as the design spec words it', () => {
    expect(rowLabel(vpn, 2, 9, NOW)).toBe(
      'Row 2 of 9, critical, ctr acme-proxy, dead, on edge-gw-02, Acme Athens-DC, 9 minutes',
    )
  })

  it('says so when a row has no age or no site', () => {
    expect(
      rowLabel(makeItem({ ageIso: null, customerName: undefined, siteName: undefined }), 1, 1, NOW),
    ).toBe('Row 1 of 1, critical, srv edge-gw-02, offline, last heartbeat 6m ago, age unavailable')
  })
})

describe('rowCopyText', () => {
  it('is one line: severity word, kind, name, detail, site, age', () => {
    expect(rowCopyText(vpn, NOW)).toBe(
      'CRIT ctr acme-proxy | dead · on edge-gw-02 | Acme / Athens-DC | 9m',
    )
  })

  it('leaves out what a row does not have', () => {
    expect(rowCopyText(api02, NOW)).toBe(
      'WARN srv api-02 | cpu 82% · warn at 80 | Globex / Thess-1',
    )
  })

  it('stays one line however the backend wrote the text', () => {
    const text = rowCopyText(makeItem({ detail: 'line one\nline two\r\n  line three' }), NOW)
    expect(text).not.toMatch(/[\r\n]/)
    expect(text).toContain('line one line two line three')
  })
})

describe('entityTarget', () => {
  it('opens the owning screen, told which entity to focus', () => {
    expect(entityTarget(edge)).toEqual({ pathname: '/servers', extra: { focus: 'srv-1' } })
    expect(entityTarget(payments)).toEqual({
      pathname: '/docker',
      extra: { focus: 'ctr-payments' },
    })
    expect(entityTarget(vpn)).toEqual({ pathname: '/docker', extra: { focus: 'ctr-proxy' } })
  })

  it('leaves escaping to the router: the id is passed through untouched', () => {
    expect(entityTarget(makeItem({ id: 'a b&c' })).extra.focus).toBe('a b&c')
  })
})

describe('filter', () => {
  const all = referenceItems()

  it('cycles ALL, CRIT, WARN and around', () => {
    expect(nextFilter('all')).toBe('critical')
    expect(nextFilter('critical')).toBe('warning')
    expect(nextFilter('warning')).toBe('all')
  })

  it('keeps the order the API gave', () => {
    expect(filterItems(all, 'critical').map((item) => item.name)).toEqual([
      'edge-gw-02',
      'acme-proxy',
      'payments-api',
      'redis-cache',
    ])
    expect(filterItems(all, 'all')).toEqual(all)
  })

  it('counts severities, and problems without idle rows', () => {
    expect(countItems(all)).toEqual({ critical: 4, warning: 5, problems: 9 })
    expect(countItems([...all, makeItem({ id: 'i', severity: 'idle' })]).problems).toBe(9)
    expect(countItems([makeItem({ id: 'u', severity: 'unknown' })])).toEqual({
      critical: 0,
      warning: 0,
      problems: 1,
    })
  })
})

describe('describeUpdates', () => {
  const base = referenceItems()

  it('is null when nothing on screen would change', () => {
    expect(describeUpdates(base, referenceItems())).toBeNull()
  })

  it('ignores values that only drift', () => {
    const drifted = referenceItems().map((item) => ({
      ...item,
      detail: `${item.detail} (later)`,
      ageIso: minutesAgo(1),
    }))
    expect(describeUpdates(base, drifted)).toBeNull()
  })

  it('counts a row appearing, disappearing and changing state', () => {
    const next = patched('acme-proxy', { severity: 'warning', stateLabel: 'DEGRADED' })
      .filter((item) => item.name !== 'edge-gw-02')
      .concat(makeItem({ id: 'srv-new', name: 'new-host', severity: 'warning' }))
    expect(describeUpdates(base, next)).toEqual({ count: 3, arrived: 2, newCritical: 0 })
  })

  it('reports a new or escalated critical', () => {
    const escalated = patched('worker-3', { severity: 'critical', stateLabel: 'DEAD' })
    expect(describeUpdates(base, escalated)).toEqual({ count: 1, arrived: 1, newCritical: 1 })

    const arrived = [...referenceItems(), makeItem({ id: 'srv-new', name: 'new-host' })]
    expect(describeUpdates(base, arrived)).toEqual({ count: 1, arrived: 1, newCritical: 1 })
  })

  it('does not call a recovering critical a new critical', () => {
    const recovered = patched('edge-gw-02', { severity: 'warning', stateLabel: 'DEGRADED' })
    expect(describeUpdates(base, recovered)).toEqual({ count: 1, arrived: 1, newCritical: 0 })
  })
})

describe('updatesText', () => {
  it('words the pill', () => {
    expect(updatesText({ count: 3, arrived: 3, newCritical: 0 })).toBe('3 updates, apply (r)')
    expect(updatesText({ count: 1, arrived: 0, newCritical: 0 })).toBe('1 update, apply (r)')
    expect(updatesText({ count: 4, arrived: 2, newCritical: 1 })).toBe(
      '2 new incl. CRIT, apply (r)',
    )
  })
})

describe('newCriticalKeys', () => {
  it('finds critical rows that were not there before', () => {
    const before = snapshot(referenceItems())
    const after = snapshot([
      ...referenceItems(),
      makeItem({ id: 'srv-new', name: 'new-host' }),
      makeItem({ id: 'srv-w', name: 'new-warn', severity: 'warning' }),
    ])
    expect([...newCriticalKeys(after, before)]).toEqual(['server:srv-new'])
  })

  it('flags nothing without an earlier snapshot to compare with', () => {
    expect(newCriticalKeys(snapshot(referenceItems()), undefined).size).toBe(0)
  })

  it('does not flag an escalation: only rows that were not present before', () => {
    const before = snapshot([makeItem({ severity: 'warning' })])
    const after = snapshot([makeItem({ severity: 'critical' })])
    expect(newCriticalKeys(after, before).size).toBe(0)
  })
})

describe('an offline server', () => {
  /** The first reference row, as the API serves a server whose agent stopped reporting. */
  const offline = makeItem({ offline: true })

  it('is read as offline in its label and its copied line', () => {
    expect(rowLabel(offline, 1, 9, NOW)).toBe(
      'Row 1 of 9, offline, srv edge-gw-02, offline, last heartbeat 6m ago, Acme Athens-DC, 6 minutes',
    )
    expect(rowCopyText(offline, NOW)).toBe(
      'OFFL srv edge-gw-02 | offline · last heartbeat 6m ago | Acme / Athens-DC | 6m',
    )
  })

  it('reads as critical when the flag is absent', () => {
    expect(rowLabel(edge, 1, 9, NOW)).toContain('Row 1 of 9, critical, srv edge-gw-02')
    expect(rowCopyText(edge, NOW)).toMatch(/^CRIT srv edge-gw-02/)
  })

  it('is still critical for the filter, the counts and the problem list', () => {
    const items = [offline, ...referenceItems().filter((item) => item.id !== offline.id)]
    expect(filterItems(items, 'critical').map((item) => item.name)).toContain('edge-gw-02')
    expect(filterItems(items, 'warning').map((item) => item.name)).not.toContain('edge-gw-02')
    expect(countItems(items)).toEqual(countItems(referenceItems()))
    expect(isProblem(offline)).toBe(true)
  })

  it('counts no update for the flag alone, and a new offline server as a new critical', () => {
    const before = referenceItems()
    const after = before.map((item) => (item.id === offline.id ? { ...item, offline: true } : item))
    expect(describeUpdates(before, after)).toBeNull()
    expect(
      describeUpdates(before, [...before, makeItem({ id: 'srv-new', offline: true })]),
    ).toEqual({
      count: 1,
      arrived: 1,
      newCritical: 1,
    })
    expect([
      ...newCriticalKeys(
        snapshot([...before, makeItem({ id: 'srv-new', offline: true })]),
        snapshot(before),
      ),
    ]).toEqual(['server:srv-new'])
  })
})
