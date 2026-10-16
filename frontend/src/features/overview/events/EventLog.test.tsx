import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { formatTime } from '@/lib/format'
import { renderApp } from '@/test/render'
import { EventLog } from './EventLog'
import { FRESH, TAIL } from './testEvents'

const log = () => screen.getByRole('log', { name: 'Recent events' })
const lines = () => within(log()).getAllByRole('listitem')
const subjects = () => lines().map((line) => line.querySelector('.type-data.truncate')?.textContent)

const NEWEST_FIRST = [
  'edge-gw-02',
  'cdn-edge:80',
  'payments-api',
  'web-02',
  'web-02',
  'srv-core-git-01',
]

describe('EventLog', () => {
  it('is a log that does not announce: role=log with aria-live off', () => {
    renderApp(<EventLog view="1h" events={TAIL} />)
    expect(log()).toHaveAttribute('aria-live', 'off')
    expect(within(log()).getByRole('list')).toBeInTheDocument()
  })

  it('lists an event that arrives twice once, with no duplicate key', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderApp(<EventLog view="1h" events={[...TAIL, ...TAIL]} />)
    expect(lines()).toHaveLength(TAIL.length)
    expect(subjects()).toEqual(NEWEST_FIRST)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('says it is the text equivalent of the timeline', () => {
    renderApp(<EventLog view="1h" events={TAIL} />)
    expect(log()).toHaveAccessibleName('Recent events')
    expect(log()).toHaveAccessibleDescription(
      /^The text equivalent of the Timeline view: every event/,
    )
  })

  it('claims every event of the range only while the events are not cut short', () => {
    const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
    expect(log()).toHaveAccessibleDescription(/: every event of the range, newest first/)
    rerender(<EventLog view="1h" events={TAIL} truncated />)
    expect(log()).toHaveAccessibleDescription(
      /: the newest events of the range, newest first, with a recovery under the failure it closes\.$/,
    )
  })

  it('lists events newest first, a group placed by its newest line', () => {
    renderApp(<EventLog view="1h" events={TAIL} />)
    expect(subjects()).toEqual(NEWEST_FIRST)
    expect(lines().map((line) => line.textContent)).toEqual([
      '14:05:12Zedge-gw-02offline',
      '14:04:40Zcdn-edge:80latency 212 ms, above 150 ms limit',
      '14:03:02Zpayments-apiunhealthy',
      '14:01:10Zweb-02heartbeat late',
      '14:01:55Zweb-02online',
      '13:50:00Zsrv-core-git-01agent updated 0.4.1 -> 0.4.2',
    ])
  })

  it('draws 24px lines and keeps five in view', () => {
    renderApp(<EventLog view="1h" events={TAIL} />)
    for (const line of lines()) expect(line).toHaveClass('h-6')
    // 5 x 24px = 7.5rem: the viewport never shrinks below five lines.
    expect(log().parentElement).toHaveClass('min-h-30')
    expect(log()).toHaveClass('overflow-y-auto')
  })

  describe('time', () => {
    it('is a real <time> in UTC with a Z by default', () => {
      renderApp(<EventLog view="1h" events={TAIL} />)
      const time = lines()[0]?.querySelector('time') as HTMLTimeElement
      expect(time).toHaveAttribute('datetime', '2026-10-12T14:05:12Z')
      expect(time).toHaveTextContent('14:05:12Z')
      expect(time).toHaveClass('text-fg-faint')
    })

    it("follows the operator's timezone when they choose local time", () => {
      window.localStorage.setItem('sentinel.prefs.v1', JSON.stringify({ tz: 'local' }))
      renderApp(<EventLog view="1h" events={TAIL} />)
      const time = lines()[0]?.querySelector('time') as HTMLTimeElement
      expect(time).toHaveAttribute('datetime', '2026-10-12T14:05:12Z')
      expect(time.textContent).toBe(formatTime(Date.parse('2026-10-12T14:05:12Z'), 'local'))
    })
  })

  describe('level glyphs', () => {
    it('map onto the status alphabet: critical, warning, healthy, and info as the neutral bar', () => {
      renderApp(<EventLog view="1h" events={TAIL} />)
      const glyphs = lines().map((line) => line.querySelector('svg'))
      expect(glyphs.map((g) => g?.getAttribute('data-status'))).toEqual([
        'critical',
        'warning',
        'critical',
        'warning',
        'healthy',
        'idle',
      ])
    })

    it('are named for the level, so an info line is not read as "idle"', () => {
      renderApp(<EventLog view="1h" events={TAIL} />)
      expect(
        within(lines()[0] as HTMLElement).getByRole('img', { name: 'critical' }),
      ).toBeInTheDocument()
      expect(within(lines()[4] as HTMLElement).getByRole('img', { name: 'ok' })).toBeInTheDocument()
      expect(
        within(lines()[5] as HTMLElement).getByRole('img', { name: 'info' }),
      ).toBeInTheDocument()
    })
  })

  describe('nesting', () => {
    it('sets a recovery under its failure with a tree guide and a level of 2', () => {
      renderApp(<EventLog view="1h" events={TAIL} />)
      const [late, online] = [lines()[3], lines()[4]] as [HTMLElement, HTMLElement]
      expect(late).not.toHaveAttribute('aria-level')
      expect(online).toHaveAttribute('aria-level', '2')
      expect(late.querySelector('[aria-hidden="true"] > span')).toBeNull()
      const guide = online.querySelector('[aria-hidden="true"]') as HTMLElement
      expect(guide).not.toBeNull()
      expect(guide.querySelector('.border-b.border-l')).not.toBeNull()
    })

    it('leaves standalone lines unindented', () => {
      renderApp(<EventLog view="1h" events={TAIL} />)
      for (const index of [0, 1, 2, 5]) {
        expect(lines()[index]?.querySelector('[aria-hidden="true"]')).toBeNull()
      }
    })
  })

  describe('keyboard', () => {
    it('is one tab stop: the first line, with the arrow keys, Home and End moving between lines', async () => {
      const user = userEvent.setup()
      renderApp(<EventLog view="1h" events={TAIL} />)
      const rows = lines()
      expect(rows.map((row) => row.getAttribute('tabindex'))).toEqual([
        '0',
        '-1',
        '-1',
        '-1',
        '-1',
        '-1',
      ])

      await user.tab()
      expect(rows[0]).toHaveFocus()
      await user.keyboard('{ArrowDown}{ArrowDown}')
      expect(rows[2]).toHaveFocus()
      expect(rows.map((row) => row.getAttribute('tabindex'))).toEqual([
        '-1',
        '-1',
        '0',
        '-1',
        '-1',
        '-1',
      ])

      await user.keyboard('{End}')
      expect(rows[5]).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(rows[5]).toHaveFocus()
      await user.keyboard('{ArrowUp}')
      expect(rows[4]).toHaveFocus()
      await user.keyboard('{Home}')
      expect(rows[0]).toHaveFocus()
      await user.keyboard('{ArrowUp}')
      expect(rows[0]).toHaveFocus()
    })

    it('comes back to the line it left when tabbing in again', async () => {
      const user = userEvent.setup()
      renderApp(
        <>
          <button type="button">before</button>
          <EventLog view="1h" events={TAIL} />
        </>,
      )
      await user.tab()
      await user.tab()
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
      await user.tab({ shift: true })
      expect(screen.getByRole('button', { name: 'before' })).toHaveFocus()
      await user.tab()
      expect(lines()[3]).toHaveFocus()
    })
  })

  describe('with fewer lines than before', () => {
    it('keeps one tab stop when the lines shrink under the remembered one', async () => {
      const user = userEvent.setup()
      const ui = (events: typeof TAIL) => (
        <>
          <EventLog view="1h" events={events} />
          <button type="button">after</button>
        </>
      )
      const { rerender } = renderApp(ui(TAIL))
      await user.tab()
      await user.keyboard('{End}')
      // The lines are held while one has focus, so they shrink once focus has left.
      rerender(ui(TAIL.slice(0, 2)))
      await user.tab()
      expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
      const rows = lines()
      expect(rows).toHaveLength(2)
      expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toEqual([rows[1]])
    })
  })

  describe('while it is being read', () => {
    it('follows new events at once when nobody is reading', () => {
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      rerender(<EventLog view="1h" events={[...FRESH, ...TAIL]} />)
      expect(lines()).toHaveLength(TAIL.length + FRESH.length)
      expect(subjects()[0]).toBe('api-02')
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('freezes under the pointer and shows an "N new" pill, then catches up when the pointer leaves', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      await user.hover(log())

      rerender(<EventLog view="1h" events={[...FRESH, ...TAIL]} />)
      expect(lines()).toHaveLength(TAIL.length)
      expect(subjects()).toEqual(NEWEST_FIRST)
      expect(screen.getByRole('button', { name: /2 new/i })).toBeInTheDocument()

      await user.unhover(log())
      expect(lines()).toHaveLength(TAIL.length + FRESH.length)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('freezes while a line has focus, and catches up on blur', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      await user.tab()

      rerender(<EventLog view="1h" events={[...FRESH, ...TAIL]} />)
      expect(lines()).toHaveLength(TAIL.length)
      expect(screen.getByRole('button', { name: /2 new/i })).toBeInTheDocument()

      act(() => (lines()[0] as HTMLElement).blur())
      expect(lines()).toHaveLength(TAIL.length + FRESH.length)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('stays frozen while either the pointer or focus is still there', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      await user.hover(log())
      await user.tab()
      rerender(<EventLog view="1h" events={[...FRESH, ...TAIL]} />)

      await user.unhover(log())
      expect(lines()).toHaveLength(TAIL.length)
      expect(screen.getByRole('button', { name: /2 new/i })).toBeInTheDocument()
    })

    it('switches at once to a different range or scope, even under the pointer', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      await user.hover(log())

      rerender(<EventLog view="24h" events={[...FRESH, ...TAIL.slice(0, 2)]} />)
      expect(lines()).toHaveLength(FRESH.length + 2)
      expect(subjects()[0]).toBe('api-02')
      expect(screen.queryByRole('button')).not.toBeInTheDocument()

      // ...and it holds again from there.
      rerender(<EventLog view="24h" events={[...FRESH, ...TAIL]} />)
      expect(lines()).toHaveLength(FRESH.length + 2)
      expect(screen.getByRole('button', { name: /4 new/i })).toBeInTheDocument()
    })

    it('counts only events that are really new, not ones that merely changed place', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      await user.hover(log())
      rerender(<EventLog view="1h" events={[...TAIL].reverse()} />)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('shows the new events when the pill is pressed, and keeps holding what comes after', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      await user.hover(log())
      rerender(<EventLog view="1h" events={[...FRESH, ...TAIL]} />)

      // fireEvent, not user.click: moving user-event's pointer onto the pill would first fire a
      // pointer-out without a relatedTarget, which no browser does between two children.
      fireEvent.click(screen.getByRole('button', { name: /2 new/i }))
      expect(lines()).toHaveLength(TAIL.length + FRESH.length)
      expect(subjects()[0]).toBe('api-02')
      expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument()
      // Focus moves to the newest line rather than being dropped with the pill.
      expect(lines()[0]).toHaveFocus()

      const later = { ...FRESH[0]!, id: 'e-later', message: 'later' }
      rerender(<EventLog view="1h" events={[later, ...FRESH, ...TAIL]} />)
      expect(lines()).toHaveLength(TAIL.length + FRESH.length)
      expect(screen.getByRole('button', { name: /1 new/i })).toBeInTheDocument()
    })
  })

  describe('Jump to newest', () => {
    it('appears only once the tail has been scrolled, and returns to the top', async () => {
      const user = userEvent.setup()
      renderApp(<EventLog view="1h" events={TAIL} />)
      expect(screen.queryByRole('button', { name: 'Jump to newest' })).not.toBeInTheDocument()

      log().scrollTop = 48
      fireEvent.scroll(log())
      const jump = screen.getByRole('button', { name: 'Jump to newest' })

      await user.click(jump)
      expect(log().scrollTop).toBe(0)
      expect(screen.queryByRole('button', { name: 'Jump to newest' })).not.toBeInTheDocument()
      expect(lines()[0]).toHaveFocus()
    })

    it('hides again when the tail is scrolled back to the top', () => {
      renderApp(<EventLog view="1h" events={TAIL} />)
      log().scrollTop = 24
      fireEvent.scroll(log())
      expect(screen.getByRole('button', { name: 'Jump to newest' })).toBeInTheDocument()
      log().scrollTop = 0
      fireEvent.scroll(log())
      expect(screen.queryByRole('button', { name: 'Jump to newest' })).not.toBeInTheDocument()
    })

    it('also brings in whatever was held back', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(<EventLog view="1h" events={TAIL} />)
      await user.hover(log())
      rerender(<EventLog view="1h" events={[...FRESH, ...TAIL]} />)
      log().scrollTop = 48
      fireEvent.scroll(log())
      expect(lines()).toHaveLength(TAIL.length)

      fireEvent.click(screen.getByRole('button', { name: 'Jump to newest' }))
      expect(lines()).toHaveLength(TAIL.length + FRESH.length)
    })
  })
})
