import { describe, expect, it } from 'vitest'
import { computeFreshness } from '@/app/live'
import { computeVerdict } from '@/lib/verdict'
import {
  GRID_ENTITIES,
  SAMPLE_ALERTS,
  SAMPLE_SERIES,
  SAMPLE_SUMMARIES,
  counts,
  stripEntities,
  summaryOf,
} from './data'
import { GALLERY_API, liveControls, summaryResource } from './scenario'

describe('sample summaries', () => {
  it.each(['critical', 'degraded', 'partial', 'nominal'] as const)(
    'produce the %s verdict, so a label in the gallery cannot lie',
    (state) => {
      expect(computeVerdict(SAMPLE_SUMMARIES[state], 'live').state).toBe(state)
    },
  )

  it('reproduce the reference story: 4 critical, 5 warning, 112 ok of 121, 3 idle', () => {
    const verdict = computeVerdict(SAMPLE_SUMMARIES.critical, 'live')
    expect(verdict.counts).toMatchObject({ critical: 4, warning: 5, healthy: 112, idle: 3 })
    expect(verdict.needAttention).toBe(9)
    expect(verdict.monitored).toBe(121)
  })

  it('derive every total from the counts', () => {
    const { servers, containers, targets } = SAMPLE_SUMMARIES.critical
    expect(servers.total).toBe(16)
    expect(servers.online).toBe(15)
    expect(containers.total).toBe(68)
    expect(containers.running).toBe(65)
    expect(targets.total).toBe(40)
    expect(targets.successTrend).toHaveLength(12)
  })

  it('count an offline server once: it is already inside critical', () => {
    const { servers } = summaryOf({
      servers: counts({ healthy: 5, critical: 1, offline: 1 }),
      containers: counts({ healthy: 3 }),
      targets: counts({ healthy: 2 }),
    })
    expect(servers.total).toBe(6)
    expect(servers.online).toBe(5)
    expect(servers.counts.offline).toBe(1)
  })
})

describe('sample entities', () => {
  it('builds strips of any length with the problems in front of the healthy', () => {
    for (const size of [6, 20, 24]) expect(stripEntities(size)).toHaveLength(size)
    expect(stripEntities(24).map((entity) => entity.status)).toEqual(
      expect.arrayContaining(['critical', 'warning', 'unknown', 'idle', 'healthy']),
    )
  })

  it('gives the grid every kind and every status, with ids unique across kinds', () => {
    expect(new Set(GRID_ENTITIES.map((entity) => entity.kind))).toEqual(
      new Set(['server', 'container', 'target', 'device']),
    )
    expect(new Set(GRID_ENTITIES.map((entity) => entity.status)).size).toBe(5)
    expect(new Set(GRID_ENTITIES.map((entity) => entity.id)).size).toBe(GRID_ENTITIES.length)
  })
})

describe('sample series', () => {
  it('is parallel arrays with one missed minute', () => {
    const { t, p95, p50, lossMean, failedProbes, probeCount } = SAMPLE_SERIES
    for (const column of [p95, p50, lossMean, failedProbes, probeCount]) {
      expect(column).toHaveLength(t.length)
    }
    expect(p95.filter((value) => value === null)).toHaveLength(1)
    expect(p95.indexOf(null)).toBe(p50.indexOf(null))
    expect(failedProbes.filter((count) => count > 0)).toHaveLength(1)
    expect(t.every((ms, index) => index === 0 || ms - (t[index - 1] ?? 0) === 60_000)).toBe(true)
  })
})

describe('scenarios', () => {
  const summary = SAMPLE_SUMMARIES.critical

  it('puts the shared summary in the state asked for', () => {
    expect(summaryResource('ready', summary)).toMatchObject({ status: 'success', data: summary })
    expect(summaryResource('loading', summary)).toMatchObject({
      status: 'loading',
      data: undefined,
    })
    expect(summaryResource('error', summary)).toMatchObject({ status: 'error', data: undefined })
    const failedRefresh = summaryResource('refresh-failed', summary)
    expect(failedRefresh.status).toBe('success')
    expect(failedRefresh.data).toBe(summary)
    expect(failedRefresh.error).toBeInstanceOf(Error)
  })

  it('stays fresh for as long as the page is open: a static page has no age to grow stale', () => {
    const { store } = liveControls('ready')
    const hourLater = Date.now() + 3_600_000
    expect(
      computeFreshness({ now: hourLater, snapshot: store.getSnapshot(), paused: false }).state,
    ).toBe('live')
  })

  it('reads NO DATA for ever once every source has failed', () => {
    const { store } = liveControls('no-data')
    const state = (now: number) =>
      computeFreshness({ now, snapshot: store.getSnapshot(), paused: false }).state
    expect(state(Date.now())).toBe('nodata')
    expect(state(Date.now() + 3_600_000)).toBe('nodata')
  })

  it('gives each scenario a store of its own, so one cannot age another', () => {
    expect(liveControls('ready').store).not.toBe(liveControls('ready').store)
  })
})

describe('gallery api', () => {
  it('labels itself mock, answers for the planned alerts tile and refuses the rest', async () => {
    expect(GALLERY_API.source).toBe('mock')
    await expect(GALLERY_API.listAlerts()).resolves.toBe(SAMPLE_ALERTS)
    await expect(GALLERY_API.getOverviewSummary()).rejects.toThrow(/no getOverviewSummary/)
  })
})
