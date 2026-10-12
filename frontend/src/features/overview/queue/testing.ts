import { createElement, type ReactElement } from 'react'
import { vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import type { AttentionResult } from '@/api/types'
import { ShellContext, type ShellApi } from '@/app/shell'
import { createTestApi, renderApp } from '@/test/render'
import type { QueueItem } from './queueModel'

/** Fixtures and harness for the queue's tests. Imported by tests only, so it never reaches the bundle. */

export const CHECKED_AT = '2026-10-12T14:05:12Z'
const NOW = Date.parse(CHECKED_AT)

/** An ISO timestamp this many minutes before the fixture's clock. */
export const minutesAgo = (minutes: number): string =>
  new Date(NOW - minutes * 60_000).toISOString()

export function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    kind: 'server',
    id: 'srv-1',
    name: 'edge-gw-02',
    severity: 'critical',
    stateLabel: 'OFFLINE',
    detail: 'offline · last heartbeat 6m ago',
    customerName: 'Acme',
    siteName: 'Athens-DC',
    ageIso: minutesAgo(6),
    ageBasis: 'last-seen',
    ...overrides,
  }
}

const acme = { customerName: 'Acme', siteName: 'Athens-DC' }
const globex = { customerName: 'Globex', siteName: 'Thess-1' }

/** The reference queue from the design spec: 4 critical, 5 warning, two rows without an age. */
export function referenceItems(): QueueItem[] {
  return [
    makeItem(),
    makeItem({
      kind: 'target',
      id: 'tgt-vpn',
      name: 'acme-vpn:443',
      protocol: 'tcp',
      stateLabel: 'DOWN',
      detail: 'connection refused · 9 failed probes',
      ageIso: minutesAgo(9),
      ageBasis: 'failing-since',
    }),
    makeItem({
      kind: 'container',
      id: 'ctr-payments',
      name: 'payments-api',
      stateLabel: 'UNHEALTHY',
      detail: 'unhealthy · on app-02',
      ...globex,
      ageIso: minutesAgo(14),
    }),
    makeItem({
      kind: 'container',
      id: 'ctr-redis',
      name: 'redis-cache',
      stateLabel: 'UNHEALTHY',
      detail: 'unhealthy · on cache-01',
      ...globex,
      ageIso: minutesAgo(14),
    }),
    makeItem({
      kind: 'container',
      id: 'ctr-worker',
      name: 'worker-3',
      severity: 'warning',
      stateLabel: 'RESTARTING',
      detail: 'restarting · on app-03',
      ...globex,
      ageIso: minutesAgo(12),
    }),
    makeItem({
      kind: 'target',
      id: 'tgt-gw',
      name: '10.20.0.1',
      protocol: 'icmp',
      severity: 'warning',
      stateLabel: 'DEGRADED',
      detail: 'loss 12% · 184 ms',
      ...acme,
      ageIso: minutesAgo(22),
      ageBasis: 'failing-since',
    }),
    makeItem({
      kind: 'target',
      id: 'tgt-cdn',
      name: 'cdn-edge:80',
      protocol: 'tcp',
      severity: 'warning',
      stateLabel: 'DEGRADED',
      detail: 'latency 212 ms · warn at 150',
      customerName: 'Initech',
      siteName: 'Patras',
      ageIso: minutesAgo(60),
      ageBasis: 'failing-since',
    }),
    makeItem({
      id: 'srv-api',
      name: 'api-02',
      severity: 'warning',
      stateLabel: 'HIGH CPU',
      detail: 'cpu 82% · warn at 80',
      ...globex,
      ageIso: null,
      ageBasis: null,
    }),
    makeItem({
      id: 'srv-db',
      name: 'db-prod-01',
      severity: 'warning',
      stateLabel: 'DISK',
      detail: 'disk 91% · warn at 80',
      ...globex,
      ageIso: null,
      ageBasis: null,
    }),
  ]
}

export function resultOf(items: QueueItem[], hiddenIdle = 0): AttentionResult {
  return { generatedAt: CHECKED_AT, items, hiddenIdle }
}

/** An API whose queue the test can replace between polls. */
export function queueApi(initial: AttentionResult) {
  let current = initial
  const listAttention = vi.fn<SentinelApi['listAttention']>(async () => current)
  return {
    api: createTestApi({ listAttention }),
    listAttention,
    set: (next: AttentionResult) => {
      current = next
    },
  }
}

function makeShell(): ShellApi {
  return {
    sidebarCollapsed: false,
    toggleSidebar: vi.fn(),
    mobileNavOpen: false,
    setMobileNavOpen: vi.fn(),
    paletteOpen: false,
    openPalette: vi.fn(),
    closePalette: vi.fn(),
    shortcutsOpen: false,
    openShortcuts: vi.fn(),
    closeShortcuts: vi.fn(),
    announce: vi.fn(),
    flashStatus: vi.fn(),
  }
}

interface RenderQueueOptions {
  api: SentinelApi
  route?: string
  pollMs?: number
}

/** Renders inside the app's providers plus a recording shell. */
export function renderQueue(ui: ReactElement, { api, route, pollMs }: RenderQueueOptions) {
  const shell = makeShell()
  const view = renderApp(createElement(ShellContext.Provider, { value: shell }, ui), {
    api,
    route,
    pollMs,
  })
  return { shell, ...view }
}
