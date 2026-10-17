import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSeries } from '@/api/types'
import { createMockApi } from '@/api/mock/client'
import { registryOverrides } from '@/config/testing'
import { renderApp } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import { SummaryPanel } from './SummaryPanel'

const NOW = Date.parse('2026-10-12T14:00:00Z')
const MINUTE = 60_000
const api = createMockApi({ now: () => NOW, delayMs: 0 })
const overrides = registryOverrides()

beforeEach(() => stubFocusVisible())
afterEach(() => {
  vi.restoreAllMocks()
  overrides.restore()
})

/** A server of the mock estate, as the page would hand it to the panel. */
const itemOf = async (id: string) => (await api.getServer(id)).item

/** One hour of one-minute buckets ending at 14:00, with the metrics given. */
function series(over: Partial<ServerSeries> = {}): ServerSeries {
  const t = Array.from({ length: 60 }, (_, i) => NOW - (60 - i) * MINUTE)
  const flat = (value: number) => t.map(() => value)
  return {
    generatedAt: new Date(NOW).toISOString(),
    bucketMs: MINUTE,
    t,
    cpu: flat(20),
    memory: flat(50),
    disk: flat(90),
    ...over,
  }
}

async function panel(id: string, history?: ServerSeries, route = '/') {
  const item = await itemOf(id)
  return renderApp(<SummaryPanel item={item} nowMs={NOW} series={history} status="success" />, {
    route,
  })
}

/** Values that move, so each sparkline names its newest one. */
const moving = () => {
  const wave = (base: number) => series().t.map((_, i) => base + (i % 3))
  return series({ cpu: wave(10), memory: wave(50), disk: wave(80) })
}

async function staleRendering(id: string, history: ServerSeries) {
  const item = await itemOf(id)
  return renderApp(
    <SummaryPanel item={item} nowMs={NOW} series={history} seriesStale status="success" />,
  )
}

const sparks = () => screen.queryAllByRole('img', { name: /history of/ })
const reserved = (root: HTMLElement) => root.querySelectorAll('[aria-hidden="true"].h-6.w-16')

describe('SummaryPanel history', () => {
  it('calls the newest sample the last one, not now, when the history is stale', async () => {
    await staleRendering('srv-ath-db-01', moving())
    const found = sparks()
    expect(found).toHaveLength(3)
    for (const spark of found) {
      expect(spark).toHaveAccessibleName(/, last \d+(\.\d)? percent/)
      expect(spark).not.toHaveAccessibleName(/\bnow\b/)
    }
  })

  it('says now for the newest sample while the history is current', async () => {
    await panel('srv-ath-db-01', moving())
    for (const spark of sparks()) expect(spark).toHaveAccessibleName(/, now \d+(\.\d)? percent/)
  })

  it('puts a sparkline beside each meter, in the same row, for CPU, RAM and disk', async () => {
    await panel('srv-ath-db-01', series())
    const found = sparks()
    expect(found).toHaveLength(3)
    for (const [label, spark] of [
      ['CPU', found[0]],
      ['RAM', found[1]],
      ['Disk', found[2]],
    ] as const) {
      expect(spark).toHaveAccessibleName(
        new RegExp(`^${label} history of ath-db-01, last hour: 13:00 to 13:59 UTC`),
      )
      const row = screen.getByRole('meter', { name: `${label} of ath-db-01` }).closest('.flex-wrap')
      expect(row).toContainElement(spark as HTMLElement)
    }
  })

  it('lets the sparkline wrap under its meter before it could squeeze the meter below 12rem', async () => {
    await panel('srv-ath-db-01', series())
    const meter = screen.getByRole('meter', { name: 'CPU of ath-db-01' }).parentElement
    const row = meter?.parentElement
    expect(row).toHaveClass('flex', 'flex-wrap', 'items-center')
    expect(meter).toHaveClass('min-w-0', 'grow', 'basis-48')
    expect(sparks()[0]).toHaveClass('w-16', 'shrink-0')
  })

  it('draws each metric from its own series, on the one 0 to 100 scale', async () => {
    const history = series({
      cpu: series().cpu.map((_, i) => 10 + (i % 3)),
      memory: series().memory.map(() => 60),
      disk: series().disk.map(() => 90),
    })
    await panel('srv-ath-db-01', history)
    const [cpu, memory, disk] = sparks()
    expect(cpu).toHaveAccessibleName(/min 10 percent, max 12 percent/)
    expect(memory).toHaveAccessibleName(/60 percent throughout/)
    expect(disk).toHaveAccessibleName(/90 percent throughout/)
    // One fixed scale for every metric: 60% and 90% sit at the heights the 0 to 100 domain gives them.
    const firstY = (root: HTMLElement | undefined) =>
      root?.querySelector('polyline')?.getAttribute('points')?.split(' ')[0]?.split(',')[1]
    expect(firstY(memory)).toBe('10.6')
    expect(firstY(disk)).toBe('6.4')
  })

  it('names the range from the series it draws, not from the one in the URL', async () => {
    await panel('srv-ath-db-01', series(), '/?range=24h')
    expect(sparks()[0]).toHaveAccessibleName(/^CPU history of ath-db-01, last hour:/)
  })

  it('breaks a line where the host sent no samples, and says how many are missing', async () => {
    const history = series()
    history.cpu = history.cpu.map((value, i) => (i >= 20 && i < 30 ? null : value))
    await panel('srv-ath-db-01', history)
    const [cpu, memory] = sparks()
    expect(cpu?.querySelectorAll('polyline')).toHaveLength(2)
    expect(cpu).toHaveAccessibleName(/10 of 60 samples missing/)
    expect(cpu?.querySelector('path')).toBeNull()
    expect(memory?.querySelectorAll('polyline')).toHaveLength(1)
    expect(memory).toHaveAccessibleName(/no samples missing/)
  })

  it('opens the figures behind a sparkline on keyboard focus, one tab stop each', async () => {
    const history = series({ cpu: series().cpu.map((_, i) => 10 + (i % 5) * 10) })
    await panel('srv-ath-db-01', history)
    await userEvent.tab()
    const [cpu, memory, disk] = sparks()
    expect(cpu).toHaveFocus()
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('CPU history of ath-db-01, last hour')
    for (const figure of [
      '13:00 to 13:59 UTC',
      'now 50 percent',
      'min 10 percent',
      'max 50 percent',
      'average 30 percent',
      'no samples missing',
    ]) {
      expect(tooltip).toHaveTextContent(figure)
    }
    await userEvent.tab()
    expect(memory).toHaveFocus()
    await userEvent.tab()
    expect(disk).toHaveFocus()
  })

  it('keeps its meters exactly as they are while the history loads, and reserves each sparkline place', async () => {
    const { container } = await panel('srv-ath-db-01', undefined)
    expect(await screen.findByRole('meter', { name: 'CPU of ath-db-01' })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'RAM of ath-db-01' })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Disk of ath-db-01' })).toBeInTheDocument()
    expect(sparks()).toHaveLength(0)
    expect(screen.queryByText('no history')).toBeNull()
    expect(reserved(container)).toHaveLength(3)
    // Same size as the sparkline that replaces it, so nothing moves when the history arrives.
    expect(reserved(container)[0]).toHaveClass('h-6', 'w-16', 'shrink-0')
  })
})

describe('SummaryPanel history of a host that stopped reporting', () => {
  it('draws the line up to the last sample, then an explicit tail, and no end dot', async () => {
    const history = await api.getServerSeries({ serverId: 'srv-pir-fs-01', range: '1h' })
    const { container } = await panel('srv-pir-fs-01', history)
    expect(screen.getByRole('region', { name: 'Summary' })).toHaveTextContent('LAST READING')
    const found = sparks()
    expect(found).toHaveLength(3)
    for (const spark of found) {
      expect(spark).toHaveAccessibleName(/no samples since 13:46 UTC$/)
      expect(spark).toHaveAccessibleName(/14 of 60 samples missing/)
      expect(spark).not.toHaveAccessibleName(/, now /)
      expect(spark.querySelector('polyline')).not.toBeNull()
      expect(spark.querySelector('path[stroke-dasharray]')).not.toBeNull()
      expect(spark.querySelector('.fill-primary')).toBeNull()
    }
    expect(container.querySelectorAll('.fill-primary')).toHaveLength(0)
    // Its last value is the last reading, not the current one.
    expect(found[0]).toHaveAccessibleName(/, last \d/)
  })

  it('says there is no history when the host has been silent for the whole range', async () => {
    const silent = series({
      cpu: series().cpu.map(() => null),
      memory: series().memory.map(() => null),
      disk: series().disk.map(() => null),
    })
    await panel('srv-pir-fs-01', silent)
    expect(screen.getAllByText('no history')).toHaveLength(3)
    expect(sparks()).toHaveLength(3)
    for (const spark of sparks()) expect(spark).not.toHaveAttribute('tabindex')
  })
})

describe('SummaryPanel history of a server that never reported', () => {
  it('has no meters and so no sparklines, and says there is nothing to show', async () => {
    const { container } = await panel('srv-core-ci-01', series())
    expect(screen.getByText(/has not sent a heartbeat yet/)).toBeInTheDocument()
    expect(screen.queryAllByRole('meter')).toHaveLength(0)
    expect(sparks()).toHaveLength(0)
    expect(reserved(container)).toHaveLength(0)
  })
})

describe('SummaryPanel without a resource reading', () => {
  it('says the agent reports but no reading has arrived, for a server whose heartbeats arrive', async () => {
    const item = await itemOf('srv-ath-db-01')
    const quiet = { ...item, server: { ...item.server, telemetry: null } }
    expect(quiet.server.lastSeenAt).not.toBeNull()
    renderApp(<SummaryPanel item={quiet} nowMs={NOW} series={undefined} status="success" />)
    expect(
      screen.getByText(/The agent reports, but no resource reading has arrived yet/),
    ).toBeVisible()
    expect(screen.queryByText(/has not sent a heartbeat yet/)).toBeNull()
    expect(screen.queryAllByRole('meter')).toHaveLength(0)
  })

  it('says it has not sent a heartbeat only for a server that never reported', async () => {
    await panel('srv-core-ci-01', series())
    expect(screen.getByText(/enrolled but its agent has not sent a heartbeat yet/)).toBeVisible()
    expect(screen.queryByText(/The agent reports/)).toBeNull()
  })
})

describe('SummaryPanel history and provenance', () => {
  it('sits in a panel tagged mock while the screen shows demo data, and claims nothing of its own', async () => {
    await panel('srv-ath-db-01', series())
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('mock')).toBeInTheDocument()
    expect(within(summary).queryByText('live')).toBeNull()
    for (const spark of sparks()) {
      expect(spark.closest('section')).toBe(summary)
      expect(spark.getAttribute('aria-label')).not.toMatch(/live|real/i)
    }
  })

  it('sits in a panel tagged live once the servers are connected and served over http', async () => {
    overrides.set('servers', { connected: true })
    const item = await itemOf('srv-ath-db-01')
    renderApp(<SummaryPanel item={item} nowMs={NOW} series={series()} status="success" />, {
      api: { ...api, source: 'http' },
    })
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('live')).toBeInTheDocument()
    expect(within(summary).queryByText('mock')).toBeNull()
    expect(sparks()).toHaveLength(3)
    for (const spark of sparks()) expect(spark.closest('section')).toBe(summary)
  })

  it('stays tagged mock over http while the servers are not connected', async () => {
    overrides.set('servers', { connected: false })
    const item = await itemOf('srv-ath-db-01')
    renderApp(<SummaryPanel item={item} nowMs={NOW} series={series()} status="success" />, {
      api: { ...api, source: 'http' },
    })
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('mock')).toBeInTheDocument()
    expect(within(summary).queryByText('live')).toBeNull()
  })
})
