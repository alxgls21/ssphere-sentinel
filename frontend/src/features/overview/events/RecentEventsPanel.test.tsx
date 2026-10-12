import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSearchParams } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { EventsOptions, SentinelEvent } from '@/api/types'
import { formatTime } from '@/lib/format'
import { createTestApi, renderApp } from '@/test/render'
import { RecentEventsPanel } from './RecentEventsPanel'
import { FRESH, TAIL } from './testEvents'

const apiWith = (events: (options: EventsOptions) => Promise<SentinelEvent[]> = async () => TAIL) =>
  createTestApi({ listEvents: vi.fn(events) })

const region = () => screen.getByRole('region', { name: 'Recent events' })
const lines = () => within(screen.getByRole('log')).getAllByRole('listitem')

describe('RecentEventsPanel', () => {
  it('is panel [6]: a dashed, PLANNED region with the sample-data footer, not marked mock', async () => {
    renderApp(<RecentEventsPanel />, { api: apiWith() })
    expect(region()).toHaveAttribute('aria-keyshortcuts', '6')
    expect(region()).toHaveAttribute('data-planned', 'true')
    expect(region()).toHaveAccessibleDescription(/Sample data\./)
    expect(within(region()).getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('Sample data. Event log not implemented.')).toBeInTheDocument()
    expect(within(region()).queryByText(/^mock/)).not.toBeInTheDocument()
    await screen.findByRole('log')
  })

  it('takes its place in the Overview grid through className', async () => {
    renderApp(<RecentEventsPanel className="col-span-4" />, { api: apiWith() })
    expect(region()).toHaveClass('col-span-4')
    await screen.findByRole('log')
  })

  it('follows the topbar range and scope, and shows the range as its scope chip', async () => {
    const api = apiWith()
    renderApp(<RecentEventsPanel />, { api, route: '/?range=6h&customer=acme' })
    await screen.findByRole('log')
    expect(api.listEvents).toHaveBeenCalledWith({
      scope: { customerId: 'acme', siteId: null },
      range: '6h',
      limit: 50,
      signal: expect.any(AbortSignal),
    })
    expect(within(region()).getByText('6h')).toBeInTheDocument()
  })

  it('shows the tail with nested recovery once data arrives', async () => {
    renderApp(<RecentEventsPanel />, { api: apiWith() })
    const log = await screen.findByRole('log', { name: 'Recent events' })
    expect(log).toHaveAttribute('aria-live', 'off')
    expect(lines()).toHaveLength(TAIL.length)
    expect(lines()[0]).toHaveTextContent('14:05:12Zedge-gw-02offline')
    expect(lines()[4]).toHaveAttribute('aria-level', '2')
  })

  it("writes line times in the operator's timezone", async () => {
    window.localStorage.setItem('sentinel.prefs.v1', JSON.stringify({ tz: 'local' }))
    renderApp(<RecentEventsPanel />, { api: apiWith() })
    await screen.findByRole('log')
    expect(lines()[0]?.querySelector('time')?.textContent).toBe(
      formatTime(Date.parse('2026-10-12T14:05:12Z'), 'local'),
    )
  })

  it('holds still under the pointer when a poll brings new events, and offers them in a pill', async () => {
    const user = userEvent.setup()
    let polls = 0
    const api = apiWith(async () => (++polls === 1 ? TAIL : [...FRESH, ...TAIL]))
    renderApp(<RecentEventsPanel />, { api, pollMs: 40 })
    await screen.findByRole('log')

    await user.hover(screen.getByRole('log'))
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2))
    expect(await screen.findByRole('button', { name: /2 new/i })).toBeInTheDocument()
    expect(lines()).toHaveLength(TAIL.length)

    await user.unhover(screen.getByRole('log'))
    await waitFor(() => expect(lines()).toHaveLength(TAIL.length + FRESH.length))
  })

  it('does not hold back a range change while a line has focus', async () => {
    const api = apiWith(async (options) => (options.range === '1h' ? TAIL : FRESH))
    function Harness() {
      const [, setSearch] = useSearchParams()
      return (
        <>
          <button type="button" onClick={() => setSearch({ range: '6h' })}>
            longer
          </button>
          <RecentEventsPanel />
        </>
      )
    }
    renderApp(<Harness />, { api })
    await screen.findByRole('log')
    act(() => lines()[0]?.focus())
    expect(lines()[0]).toHaveFocus()

    // fireEvent: a real click would move focus off the line, and the range key (t) does not.
    fireEvent.click(screen.getByRole('button', { name: 'longer' }))
    await waitFor(() => expect(lines()).toHaveLength(FRESH.length))
    expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument()
    expect(within(region()).getByText('6h')).toBeInTheDocument()
  })

  describe('states', () => {
    it('says there are no events in range', async () => {
      renderApp(<RecentEventsPanel />, { api: apiWith(async () => []) })
      expect(await screen.findByText('No events in range')).toBeInTheDocument()
      expect(screen.getByText('Nothing was logged in the last 1h.')).toBeInTheDocument()
      expect(screen.queryByRole('log')).not.toBeInTheDocument()
      expect(screen.getByText('Sample data. Event log not implemented.')).toBeInTheDocument()
    })

    it('shows a skeleton of five lines only after a short delay', async () => {
      const { container } = renderApp(<RecentEventsPanel />, {
        api: apiWith(() => new Promise<SentinelEvent[]>(() => {})),
      })
      expect(region()).toHaveAttribute('aria-busy', 'true')
      expect(container.querySelector('.animate-skeleton')).toBeNull()
      await waitFor(() => expect(container.querySelectorAll('.animate-skeleton')).toHaveLength(5))
      expect(screen.queryByRole('log')).not.toBeInTheDocument()
    })

    it('shows an inline error with Retry, and recovers', async () => {
      const user = userEvent.setup()
      let failing = true
      const api = apiWith(async () => {
        if (failing) throw new Error('boom')
        return TAIL
      })
      renderApp(<RecentEventsPanel />, { api })
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recent events')

      failing = false
      await user.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByRole('log')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
