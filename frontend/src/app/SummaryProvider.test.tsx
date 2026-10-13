import { act, screen } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverviewSummary } from '@/api/types'
import { makeSummary } from '@/shell/testing'
import { createTestApi, renderApp } from '@/test/render'
import { SummaryProvider } from './SummaryProvider'
import { SummaryContext } from './summary'

function Servers() {
  const summary = useContext(SummaryContext)
  return <output aria-label="servers">{summary?.data?.servers.total ?? 'none'}</output>
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SummaryProvider', () => {
  it('keeps the newest summary when requests finish out of order after the tab returns', async () => {
    vi.useFakeTimers()
    const calls: { signal: AbortSignal; resolve: (summary: OverviewSummary) => void }[] = []
    const getOverviewSummary = vi.fn(
      (options?: { signal?: AbortSignal }) =>
        new Promise<OverviewSummary>((resolve) =>
          calls.push({ signal: options?.signal as AbortSignal, resolve }),
        ),
    )
    renderApp(
      <SummaryProvider>
        <Servers />
      </SummaryProvider>,
      { api: createTestApi({ getOverviewSummary }), pollMs: 1000 },
    )
    expect(calls).toHaveLength(1)

    // The first request is still out when the tab comes back and the data is overdue.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.signal.aborted).toBe(true)

    await act(async () => calls[1]!.resolve(makeSummary({ servers: { healthy: 11 } })))
    await act(async () => calls[0]!.resolve(makeSummary({ servers: { healthy: 3 } })))

    expect(screen.getByLabelText('servers')).toHaveTextContent('11')
    // One poll chain only: a second interval brings exactly one more request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(calls).toHaveLength(3)
  })
})
