import type { ReactElement } from 'react'
import { vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import type { OverviewSummary, ScopeOptions, StatusCounts } from '@/api/types'
import { emptyCounts } from '@/lib/status'
import { createTestApi, renderApp } from '@/test/render'
import { ShellProvider } from './ShellProvider'

const WIDTH_QUERY = /\(width\s*(<|>=)\s*([\d.]+)rem\)/

/**
 * Pins the viewport for useMediaQuery. jsdom has no layout, so the shell's
 * width queries ("(width < 64rem)") are answered from this width; every other
 * query (reduced motion, pointer) reads false. The returned `resize` changes the
 * width and notifies subscribers, as a real window resize would. Undo with
 * vi.unstubAllGlobals().
 */
export function stubViewport(widthPx: number): { resize: (widthPx: number) => void } {
  let width = widthPx
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => {
    const match = WIDTH_QUERY.exec(query)
    const limit = match ? Number(match[2]) * 16 : null
    return {
      get matches() {
        if (!match || limit === null) return false
        return match[1] === '<' ? width < limit : width >= limit
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }
  })
  return {
    resize: (next) => {
      width = next
      listeners.forEach((listener) => listener())
    },
  }
}

export const DESKTOP = 1600
export const LAPTOP = 1100
export const TABLET = 900
export const PHONE = 390

export function counts(partial: Partial<StatusCounts> = {}): StatusCounts {
  return { ...emptyCounts(), ...partial }
}

interface SummaryInput {
  servers?: Partial<StatusCounts>
  containers?: Partial<StatusCounts>
}

/** A summary built from just the counts a test cares about. */
export function makeSummary({ servers, containers }: SummaryInput = {}): OverviewSummary {
  const total = (c: StatusCounts) => c.healthy + c.warning + c.critical + c.unknown + c.idle
  const s = counts({ healthy: 10, ...servers })
  const c = counts({ healthy: 20, ...containers })
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    servers: { total: total(s), counts: s },
    containers: { total: total(c), counts: c },
  }
}

export const SCOPE_OPTIONS: ScopeOptions = {
  customers: [
    { id: 'acme', name: 'Acme' },
    { id: 'globex', name: 'Globex' },
  ],
  sites: [
    { id: 'athens', customerId: 'acme', name: 'Athens DC' },
    { id: 'patras', customerId: 'acme', name: 'Patras' },
    { id: 'thess', customerId: 'globex', name: 'Thess-1' },
  ],
}

interface ShellRenderOptions {
  summary?: OverviewSummary
  api?: Partial<SentinelApi>
  route?: string
  pollMs?: number
}

/** Renders inside the app's providers plus the shell's own (sidebar, overlays, announcer). */
export function renderShell(
  ui: ReactElement,
  { summary = makeSummary(), api, route, pollMs }: ShellRenderOptions = {},
) {
  return renderApp(<ShellProvider>{ui}</ShellProvider>, {
    api: createTestApi({
      getOverviewSummary: async () => summary,
      getScopeOptions: async () => SCOPE_OPTIONS,
      ...api,
    }),
    route,
    pollMs,
    withSummary: true,
  })
}
