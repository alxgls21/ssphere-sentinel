import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewSummary } from '@/api/types'
import { makeSummary, renderShell } from './testing'
import { useDocumentStatus } from './useDocumentStatus'

const CRITICAL = makeSummary({
  servers: { critical: 1 },
  containers: { critical: 2 },
  targets: { critical: 1 },
})
const NOMINAL = makeSummary()

function Host({ title = 'Overview' }: { title?: string }) {
  useDocumentStatus(title)
  return null
}

beforeEach(() => {
  document.title = 'Sentinel'
  const link = document.createElement('link')
  link.rel = 'icon'
  link.href = '/favicon.svg'
  document.head.append(link)
  document.documentElement.style.setProperty('--color-bg', 'ground-token')
  document.documentElement.style.setProperty('--color-critical', 'critical-token')
  document.documentElement.style.setProperty('--color-healthy', 'healthy-token')
  document.documentElement.style.setProperty('--color-fg-muted', 'muted-token')
})

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.removeAttribute('style')
  document.head.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove())
})

const favicon = () =>
  decodeURIComponent(
    (document.querySelector('link[rel~="icon"]') as HTMLLinkElement).href.replace(
      'data:image/svg+xml,',
      '',
    ),
  )

describe('useDocumentStatus: title and favicon', () => {
  it('claims no verdict before the first answer', () => {
    renderShell(<Host />, { api: { getOverviewSummary: () => new Promise(() => {}) } })
    expect(document.title).toBe('[MOCK] Overview - Sentinel')
    expect(document.querySelector('link[rel~="icon"]')).toHaveAttribute('href', '/favicon.svg')
  })

  it('carries the verdict in the title, and its shape and color in the favicon', async () => {
    renderShell(<Host />, { summary: CRITICAL })
    await waitFor(() => expect(document.title).toBe('[MOCK] ◆ 4 CRIT - Overview - Sentinel'))
    expect(favicon()).toContain('fill="critical-token"')
    expect(favicon()).toContain('M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z')
    expect(favicon()).toContain('stroke="muted-token"')
  })

  it('shows a calm fleet as the OK circle', async () => {
    renderShell(<Host />, { summary: NOMINAL })
    await waitFor(() => expect(document.title).toBe('[MOCK] ● 38 OK - Overview - Sentinel'))
    expect(favicon()).toContain('<circle cx="5" cy="5" r="4" fill="healthy-token"/>')
  })

  it('names the screen it is on', async () => {
    renderShell(<Host title="Servers" />, { summary: CRITICAL })
    await waitFor(() => expect(document.title).toBe('[MOCK] ◆ 4 CRIT - Servers - Sentinel'))
  })

  it('drops the MOCK prefix and the hatched corner for a real API', async () => {
    renderShell(<Host />, { summary: CRITICAL, api: { source: 'http' } })
    await waitFor(() => expect(document.title).toBe('◆ 4 CRIT - Overview - Sentinel'))
    expect(favicon()).not.toContain('muted-token')
  })

  it('says NO DATA when every request failed', async () => {
    renderShell(<Host />, {
      api: {
        getOverviewSummary: () => Promise.reject(new Error('down')),
      },
    })
    await waitFor(() => expect(document.title).toBe('[MOCK] ○ NO DATA - Overview - Sentinel'))
  })
})

describe('useDocumentStatus: announcing verdict changes', () => {
  const announcer = () => screen.getByRole('status', { name: 'Announcements' })

  /** A summary the test can change between polls. */
  function liveSummary(first: OverviewSummary) {
    const box = { current: first }
    return { box, getOverviewSummary: async () => box.current }
  }

  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('stays silent for the verdict the page starts with', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { getOverviewSummary } = liveSummary(CRITICAL)
    renderShell(<Host />, { api: { getOverviewSummary }, pollMs: 10_000 })
    await elapse(60_000)
    expect(announcer()).toBeEmptyDOMElement()
  })

  it('announces a change once it has held for two poll cycles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { box, getOverviewSummary } = liveSummary(CRITICAL)
    renderShell(<Host />, { api: { getOverviewSummary }, pollMs: 10_000 })
    await elapse(1000)

    box.current = NOMINAL
    await elapse(10_000) // the poll that sees it
    await elapse(19_000)
    expect(announcer()).toBeEmptyDOMElement()
    await elapse(2000)
    expect(announcer()).toHaveTextContent('Verdict NOMINAL. 0 of 38 need attention.')
  })

  it('does not announce a flap that settled back before two poll cycles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { box, getOverviewSummary } = liveSummary(CRITICAL)
    renderShell(<Host />, { api: { getOverviewSummary }, pollMs: 10_000 })
    await elapse(1000)

    box.current = NOMINAL
    await elapse(10_000) // the poll that sees it: the 20 s clock starts
    box.current = CRITICAL
    // React only renders when an act() scope ends, so step poll by poll.
    for (let poll = 0; poll < 6; poll++) await elapse(10_000)
    expect(announcer()).toBeEmptyDOMElement()
  })
})
