import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSearchParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  describe('views', () => {
    const READ_AT = Date.parse('2026-10-12T14:20:00Z')
    const view = (name: 'Log' | 'Timeline') => screen.getByRole('tab', { name })
    const timeline = () => screen.getByRole('list', { name: 'Incident timeline' })
    const lanes = () => within(timeline()).getAllByRole('listitem')

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(READ_AT)
    })
    afterEach(() => vi.useRealTimers())

    it('offers the log and the timeline as tabs in the header, the log selected', async () => {
      renderApp(<RecentEventsPanel />, { api: apiWith() })
      await screen.findByRole('log')
      const tabs = within(region()).getByRole('tablist', { name: 'Events view' })
      expect(
        within(tabs)
          .getAllByRole('tab')
          .map((tab) => tab.textContent),
      ).toEqual(['Log', 'Timeline'])
      expect(view('Log')).toHaveAttribute('aria-selected', 'true')
      expect(view('Timeline')).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('tabpanel', { name: 'Log' })).toContainElement(
        screen.getByRole('log'),
      )
      expect(screen.queryByRole('list', { name: 'Incident timeline' })).not.toBeInTheDocument()
    })

    it('shows the incidents among the same events when the timeline is chosen', async () => {
      const user = userEvent.setup()
      renderApp(<RecentEventsPanel />, { api: apiWith() })
      await screen.findByRole('log')

      await user.click(view('Timeline'))
      expect(view('Timeline')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tabpanel', { name: 'Timeline' })).toContainElement(timeline())
      expect(screen.queryByRole('log')).not.toBeInTheDocument()
      // Four failures: three still open, web-02 back after 45 seconds. The agent update is not one.
      expect(screen.getByText('3 ongoing · 1 resolved')).toBeInTheDocument()
      expect(lanes().map((lane) => lane.getAttribute('aria-label'))).toEqual([
        'edge-gw-02: critical incident, started 14:05, ongoing for 14 minutes',
        'payments-api: critical incident, started 14:03, ongoing for 16 minutes',
        'cdn-edge:80: warning incident, started 14:04, ongoing for 15 minutes',
        'web-02: warning incident, started 14:01, resolved after less than a minute at 14:01',
      ])
      expect(timeline()).toHaveAccessibleDescription('Last hour, 13:20 to 14:20. Times are UTC.')
    })

    it('changes views from the keyboard like any segmented control, and back to the unchanged log', async () => {
      const user = userEvent.setup()
      renderApp(<RecentEventsPanel />, { api: apiWith() })
      await screen.findByRole('log')
      act(() => view('Log').focus())

      await user.keyboard('{ArrowRight}')
      expect(timeline()).toBeInTheDocument()
      await user.keyboard('{ArrowLeft}')
      expect(screen.queryByRole('list', { name: 'Incident timeline' })).not.toBeInTheDocument()
      expect(lines()).toHaveLength(TAIL.length)
      expect(lines()[0]).toHaveTextContent('14:05:12Zedge-gw-02offline')
    })

    it('needs no extra request: both views read the one answer', async () => {
      const user = userEvent.setup()
      const api = apiWith()
      renderApp(<RecentEventsPanel />, { api })
      await screen.findByRole('log')
      expect(api.listEvents).toHaveBeenCalledTimes(1)

      await user.click(view('Timeline'))
      await user.click(view('Log'))
      await user.click(view('Timeline'))
      expect(api.listEvents).toHaveBeenCalledTimes(1)
    })

    it('follows the topbar range and scope with one request, in either view', async () => {
      const user = userEvent.setup()
      const api = apiWith()
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
      await user.click(view('Timeline'))
      expect(timeline()).toHaveAccessibleDescription(/^Last hour/)

      await user.click(screen.getByRole('button', { name: 'longer' }))
      await waitFor(() => expect(timeline()).toHaveAccessibleDescription(/^Last 6 hours/))
      expect(api.listEvents).toHaveBeenCalledTimes(2)
      expect(api.listEvents).toHaveBeenLastCalledWith(expect.objectContaining({ range: '6h' }))
      expect(within(region()).getByText('6h')).toBeInTheDocument()
    })

    it('says there are no incidents when the events hold none, where the log still lists them', async () => {
      const user = userEvent.setup()
      const info = [TAIL[5] as SentinelEvent]
      renderApp(<RecentEventsPanel />, { api: apiWith(async () => info) })
      await screen.findByRole('log')
      expect(lines()).toHaveLength(1)

      await user.click(view('Timeline'))
      expect(screen.getByText('No incidents in the last 1h')).toBeInTheDocument()
      expect(screen.queryByRole('list', { name: 'Incident timeline' })).not.toBeInTheDocument()

      await user.click(view('Log'))
      expect(lines()[0]).toHaveTextContent('agent updated 0.4.1 -> 0.4.2')
    })

    it('keeps the empty state of the log for no events, and says no incidents on the timeline', async () => {
      const user = userEvent.setup()
      renderApp(<RecentEventsPanel />, { api: apiWith(async () => []) })
      expect(await screen.findByText('No events in range')).toBeInTheDocument()

      await user.click(view('Timeline'))
      expect(screen.getByText('No incidents in the last 1h')).toBeInTheDocument()
      expect(screen.queryByText('No events in range')).not.toBeInTheDocument()
    })

    it.each(['Log', 'Timeline'] as const)(
      'is a dashed PLANNED region with its sample-data footer in the %s view, and never claims to be live',
      async (name) => {
        const user = userEvent.setup()
        renderApp(<RecentEventsPanel />, { api: apiWith() })
        await screen.findByRole('log')
        await user.click(view(name))

        expect(region()).toHaveAttribute('data-planned', 'true')
        expect(region()).toHaveAccessibleDescription(/Sample data\./)
        expect(within(region()).getByText('Planned')).toBeInTheDocument()
        expect(screen.getByText('Sample data. Event log not implemented.')).toBeInTheDocument()
        expect(within(region()).queryByText(/^mock/)).not.toBeInTheDocument()
        expect(region()).not.toHaveTextContent(/\blive\b/i)
      },
    )

    describe('when the answer fills the limit', () => {
      const MINUTE = 60_000
      const ago = (minutes: number) => new Date(READ_AT - minutes * MINUTE).toISOString()
      const mark = (
        id: string,
        minutes: number,
        level: SentinelEvent['level'],
        subject: string,
        parentId?: string,
      ): SentinelEvent => ({
        id,
        at: ago(minutes),
        level,
        subject: { kind: 'server', id: subject, name: subject },
        message: `${id} message`,
        ...(parentId ? { parentId } : {}),
      })
      /** Newest first: one agent update, then sixty incidents (failure, recovery five minutes later), all inside 24 hours. */
      const history = (): SentinelEvent[] => [
        mark('update', 1, 'info', 'srv-core-git-01'),
        ...Array.from({ length: 60 }, (_, i) => [
          mark(`ok-${i}`, i * 20 + 10, 'healthy', `srv-${i}`, `fail-${i}`),
          mark(`fail-${i}`, i * 20 + 15, 'critical', `srv-${i}`),
        ]).flat(),
      ]
      const serving = (all: SentinelEvent[]) => apiWith(async ({ limit }) => all.slice(0, limit))

      it('does not claim that the failure of a recovery it cut off began before the range', async () => {
        const user = userEvent.setup()
        renderApp(<RecentEventsPanel />, { api: serving(history()), route: '/?range=24h' })
        await screen.findByRole('log')
        expect(lines()).toHaveLength(50)
        await user.click(view('Timeline'))

        // Events 1 to 49 hold the recoveries of srv-0 to srv-24, and the failures of srv-0 to srv-23.
        expect(lanes()).toHaveLength(25)
        expect(within(timeline()).getByRole('listitem', { name: /^srv-24:/ })).toHaveAccessibleName(
          'srv-24: incident whose opening is not among the events shown, resolved at Monday 06:10',
        )
        expect(
          within(timeline()).queryByRole('listitem', { name: /began before the last/ }),
        ).not.toBeInTheDocument()
        expect(screen.getByText('0 ongoing · 25 resolved · newest events only')).toBeInTheDocument()
      })

      it('says in the log that it holds the newest events, not every event of the range', async () => {
        renderApp(<RecentEventsPanel />, { api: serving(history()), route: '/?range=24h' })
        expect(await screen.findByRole('log')).toHaveAccessibleDescription(
          /the newest events of the range/,
        )
      })

      it('keeps saying that an opening older than the range is, when the answer is complete', async () => {
        const user = userEvent.setup()
        const complete = [mark('ok', 30, 'healthy', 'srv-9', 'fail-9')]
        renderApp(<RecentEventsPanel />, { api: serving(complete), route: '/?range=24h' })
        expect(await screen.findByRole('log')).toHaveAccessibleDescription(
          /: every event of the range/,
        )
        await user.click(view('Timeline'))
        expect(lanes()[0]).toHaveAccessibleName(
          /^srv-9: incident that began before the last 24 hours/,
        )
        expect(screen.queryByText(/newest events only/)).not.toBeInTheDocument()
      })
    })

    it('holds the lanes still under the pointer when a poll brings new events, and offers them in a pill', async () => {
      const user = userEvent.setup()
      let polls = 0
      const api = apiWith(async () => (++polls === 1 ? TAIL : [...FRESH, ...TAIL]))
      renderApp(<RecentEventsPanel />, { api, pollMs: 40 })
      await screen.findByRole('log')
      await user.click(view('Timeline'))

      await user.hover(timeline())
      await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2))
      expect(await screen.findByRole('button', { name: /2 new/i })).toBeInTheDocument()
      expect(lanes()).toHaveLength(4)

      await user.unhover(timeline())
      await waitFor(() => expect(lanes()).toHaveLength(6))
    })
  })
})
