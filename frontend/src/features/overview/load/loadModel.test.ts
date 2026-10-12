import { describe, expect, it } from 'vitest'
import type { FleetLoadRow } from '@/api/types'
import {
  LOAD_TABS,
  THRESHOLD_NOTE,
  excludedNote,
  metricNoun,
  percentText,
  rowTooltip,
} from './loadModel'

const row = (overrides: Partial<FleetLoadRow> = {}): FleetLoadRow => ({
  serverId: 'srv-1',
  name: 'api-02',
  percent: 82,
  collectedAt: '2026-10-12T14:05:03Z',
  ...overrides,
})

describe('LOAD_TABS', () => {
  it('maps CPU | RAM | DISK onto the API metrics, in that order', () => {
    expect(LOAD_TABS.map(({ value, label }) => [label, value])).toEqual([
      ['CPU', 'cpu'],
      ['RAM', 'memory'],
      ['DISK', 'disk'],
    ])
  })

  it('reads each metric naturally in a sentence', () => {
    expect(
      ['cpu', 'memory', 'disk'].map((m) => metricNoun(m as 'cpu' | 'memory' | 'disk')),
    ).toEqual(['CPU', 'RAM', 'Disk'])
  })
})

describe('THRESHOLD_NOTE', () => {
  it('states the cell size and the thresholds from lib, labelled as UI defaults', () => {
    expect(THRESHOLD_NOTE).toBe('cell = 5% · warn at 80 · crit at 95 · UI defaults')
  })
})

describe('excludedNote', () => {
  it('is null when every server has a sample', () => {
    expect(excludedNote([])).toBeNull()
  })

  it('names the servers without a sample and does not guess why', () => {
    expect(excludedNote(['edge-gw-02'])).toBe('edge-gw-02: no sample, excluded')
    expect(excludedNote(['a', 'b', 'c'])).toBe('a, b, c: no sample, excluded')
  })

  it('names three and counts the rest', () => {
    expect(excludedNote(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, +2 more: no sample, excluded')
  })
})

describe('percentText', () => {
  it('prints whole numbers from 10% and one decimal below, like the meter', () => {
    expect(percentText(82)).toBe('82%')
    expect(percentText(10)).toBe('10%')
    expect(percentText(4.2)).toBe('4.2%')
    expect(percentText(0)).toBe('0.0%')
  })
})

describe('rowTooltip', () => {
  it('names the server, metric, value and when the sample was taken (UTC with a Z)', () => {
    expect(rowTooltip(row(), 'CPU', 'utc')).toBe('api-02 · CPU 82% · sampled 14:05:03Z')
  })

  it('uses the local clock without a Z when the operator chose local time', () => {
    const local = new Date('2026-10-12T14:05:03Z')
    const clock = [local.getHours(), local.getMinutes(), local.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':')
    expect(rowTooltip(row({ percent: 4.2 }), 'Disk', 'local')).toBe(
      `api-02 · Disk 4.2% · sampled ${clock}`,
    )
  })
})
