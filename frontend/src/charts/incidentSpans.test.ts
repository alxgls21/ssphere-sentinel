import { describe, expect, it } from 'vitest'
import { incident } from '@/features/alerts/testing'
import type { IncidentItem } from '@/api/types'
import type { ChartColors } from './theme'
import { CHART_COLOR_TOKENS } from './theme'
import { incidentSentence, incidentSeries, incidentSpans } from './incidentSpans'

const T = (hhmm: string) => Date.parse(`2026-10-12T${hhmm}:00Z`)
const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors

const at = (over: Partial<IncidentItem>, ref = 'srv-1'): IncidentItem => ({
  ...incident({ kind: 'server', ref }),
  startedAt: '2026-10-12T13:30:00Z',
  recoveredAt: null,
  closedAt: null,
  ...over,
})

describe('incidentSpans', () => {
  const NOW = T('14:00')

  it('runs an open incident from when its condition began to now', () => {
    const [span] = incidentSpans([at({})], 'srv-1', T('13:00'), T('14:00'), NOW)
    expect(span).toMatchObject({ start: T('13:30'), end: NOW, open: true, severity: 'critical' })
  })

  it('ends a recovered or closed incident when it did', () => {
    const [recovered, closed] = incidentSpans(
      [
        at({ id: 'a', startedAt: '2026-10-12T13:10:00Z', recoveredAt: '2026-10-12T13:20:00Z' }),
        at({ id: 'b', startedAt: '2026-10-12T13:30:00Z', closedAt: '2026-10-12T13:40:00Z' }),
      ],
      'srv-1',
      T('13:00'),
      T('14:00'),
      NOW,
    )
    expect(recovered).toMatchObject({ end: T('13:20'), open: false })
    expect(closed).toMatchObject({ end: T('13:40'), open: false })
  })

  it('keeps only the incidents of this object', () => {
    const spans = incidentSpans(
      [at({ id: 'mine' }), at({ id: 'other' }, 'srv-2')],
      'srv-1',
      T('13:00'),
      T('14:00'),
      NOW,
    )
    expect(spans.map((span) => span.id)).toEqual(['mine'])
  })

  it('clips to the range, and drops what is wholly outside it', () => {
    const spans = incidentSpans(
      [
        at({
          id: 'before',
          startedAt: '2026-10-12T11:00:00Z',
          recoveredAt: '2026-10-12T12:00:00Z',
        }),
        at({
          id: 'across',
          startedAt: '2026-10-12T12:30:00Z',
          recoveredAt: '2026-10-12T13:20:00Z',
        }),
        at({ id: 'after', startedAt: '2026-10-12T15:00:00Z' }),
      ],
      'srv-1',
      T('13:00'),
      T('14:00'),
      NOW,
    )
    expect(spans.map((span) => [span.id, span.start, span.end])).toEqual([
      ['across', T('13:00'), T('13:20')],
    ])
  })

  it('goes oldest first, and skips one whose start is not a time', () => {
    const spans = incidentSpans(
      [
        at({ id: 'late', startedAt: '2026-10-12T13:40:00Z' }),
        at({ id: 'early', startedAt: '2026-10-12T13:10:00Z' }),
        at({ id: 'bad', startedAt: 'not a time' }),
      ],
      'srv-1',
      T('13:00'),
      T('14:00'),
      NOW,
    )
    expect(spans.map((span) => span.id)).toEqual(['early', 'late'])
  })

  it('never ends before it began', () => {
    const [span] = incidentSpans(
      [at({ startedAt: '2026-10-12T13:30:00Z', recoveredAt: '2026-10-12T13:20:00Z' })],
      'srv-1',
      T('13:00'),
      T('14:00'),
      NOW,
    )
    expect(span!.end).toBeGreaterThanOrEqual(span!.start)
  })
})

describe('incidentSeries', () => {
  const spans = incidentSpans(
    [
      at({ id: 'c', severity: 'critical' }),
      at({
        id: 'w',
        severity: 'warning',
        startedAt: '2026-10-12T13:10:00Z',
        recoveredAt: '2026-10-12T13:20:00Z',
      }),
    ],
    'srv-1',
    T('13:00'),
    T('14:00'),
    T('14:00'),
  )
  const build = (labelled: boolean) =>
    incidentSeries('inc', 2, { spans, colors, fontFamily: 'mono', px: (v) => v, labelled })
  const areas = (labelled: boolean) =>
    (build(labelled).markArea as { data: [Record<string, unknown>, Record<string, unknown>][] })
      .data

  it('is a silent series with no points, on the grid it is given', () => {
    const series = build(true)
    expect(series).toMatchObject({
      id: 'inc',
      xAxisIndex: 2,
      yAxisIndex: 2,
      silent: true,
      data: [],
    })
  })

  it('shades one area per incident, in its severity’s color', () => {
    const [warning, critical] = areas(true)
    expect((warning![0]!.itemStyle as { color: string }).color).toBe('token:warning')
    expect((critical![0]!.itemStyle as { color: string }).color).toBe('token:critical')
    expect(warning![0]!.xAxis).toBe(T('13:10'))
    expect(warning![1]!.xAxis).toBe(T('13:20'))
  })

  it('names the incidents only on the grid that is labelled', () => {
    expect(areas(true).map(([start]) => (start!.label as { show: boolean }).show)).toEqual([
      true,
      true,
    ])
    expect(areas(false).map(([start]) => (start!.label as { show: boolean }).show)).toEqual([
      false,
      false,
    ])
    expect(areas(true)[1]![0]!.name).toBe('INC CRIT')
  })
})

describe('incidentSentence', () => {
  const span = (over = {}) => ({
    id: 'i',
    severity: 'critical' as const,
    start: T('13:30'),
    end: T('14:00'),
    open: true,
    rule: 'Server offline',
    ...over,
  })

  it('says nothing when there is none', () => {
    expect(incidentSentence([], 'utc')).toBe('')
  })

  it('says one incident, its severity, rule and start, and that it is still open', () => {
    expect(incidentSentence([span()], 'utc')).toBe(
      '1 incident marked: critical “Server offline” from 13:30 UTC, still open',
    )
  })

  it('counts several, and leaves out "still open" for one that ended', () => {
    const text = incidentSentence([span({ open: false, severity: 'warning' }), span()], 'utc')
    expect(text).toMatch(/^2 incidents marked: warning “Server offline” from 13:30 UTC; critical/)
    expect(text.split('still open')).toHaveLength(2)
  })
})
