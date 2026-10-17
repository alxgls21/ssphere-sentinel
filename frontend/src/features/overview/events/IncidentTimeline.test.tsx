import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RangeKey, SentinelEvent } from '@/api/types'
import { formatTime } from '@/lib/format'
import { renderApp } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import { STATUS_EDGE, STATUS_TINT } from '@/ui/status'
import { LANE_COLUMNS } from './IncidentLane'
import { EventLog } from './EventLog'
import { IncidentTimeline } from './IncidentTimeline'
import { STORY_NOW, storyEvents } from './storyEvents'
import { event } from './testEvents'

const MINUTE = 60_000
const NOW = STORY_NOW

/** The events of the fixture's outage story for a range, as seen at `at`. */
const storyAt = (range: RangeKey, at = NOW) => storyEvents(range, at)

function renderTimeline(
  events: readonly SentinelEvent[],
  {
    range = '6h',
    now = NOW,
    truncated = false,
  }: { range?: RangeKey; now?: number; truncated?: boolean } = {},
) {
  const view = `all:${range}`
  const ui = (list: readonly SentinelEvent[], at = now) => (
    <IncidentTimeline view={view} events={list} range={range} now={at} truncated={truncated} />
  )
  const utils = renderApp(ui(events))
  return {
    ...utils,
    update: (list: readonly SentinelEvent[], at = now) => utils.rerender(ui(list, at)),
  }
}

const list = () => screen.getByRole('list', { name: 'Incident timeline' })
const lanes = () => within(list()).getAllByRole('listitem')
const lane = (name: string | RegExp) => within(list()).getByRole('listitem', { name })
const names = () => lanes().map((item) => item.getAttribute('aria-label'))
const glyphs = (item: HTMLElement) =>
  [...item.querySelectorAll('svg[data-status]')].map((svg) => svg.getAttribute('data-status'))
const part = (item: HTMLElement, name: string) => item.querySelector(`[data-part="${name}"]`)
const bar = (item: HTMLElement) => part(item, 'bar') as HTMLElement

const PIR_VPN = 'pir-vpn: critical incident, started 13:52, ongoing for 12 minutes'
const MUC_VPN = 'muc-vpn: warning incident, started 14:02, ongoing for 3 minutes'
const ATH_API = 'ath-api: warning incident, started 10:55, resolved after 22 minutes at 11:17'
const HC_BKP = 'hc-bkp-01: warning incident, started 13:18, ongoing for 47 minutes'

beforeEach(() => stubFocusVisible())
afterEach(() => vi.restoreAllMocks())

describe('IncidentTimeline', () => {
  describe('the timeline', () => {
    it('is a named list with one lane per incident, ongoing first, critical before warning, the resolved last', async () => {
      renderTimeline(storyAt('6h'))
      expect(lanes()).toHaveLength(20)
      expect(names().slice(0, 4)).toEqual([
        PIR_VPN,
        'pir-fs-01: critical incident, started 13:52, ongoing for 13 minutes',
        'pir-sw1: critical incident, started 13:52, ongoing for 13 minutes',
        'pir-gateway: critical incident, started 13:51, ongoing for 13 minutes',
      ])
      expect(names().slice(-3)).toEqual([
        'fra-cache-01: warning incident, started 12:07, resolved after 22 minutes at 12:29',
        ATH_API,
        'fra-web-01: warning incident, started 08:05, resolved after 29 minutes at 08:34',
      ])
    })

    it('says how many are ongoing and how many resolved, above the lanes', async () => {
      renderTimeline(storyAt('6h'))
      const summary = screen.getByText('17 ongoing · 3 resolved')
      expect(
        summary.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it('describes the window it covers and the timezone of the lane names', async () => {
      renderTimeline(storyAt('6h'))
      expect(list()).toHaveAccessibleDescription('Last 6 hours, 08:05 to 14:05. Times are UTC.')
    })

    it('draws one axis, with its ends labelled in the timezone and a Z for UTC', async () => {
      renderTimeline(storyAt('6h'))
      expect(screen.getAllByText('08:05Z')).toHaveLength(1)
      expect(screen.getAllByText('14:05Z')).toHaveLength(1)
    })

    it('names the weekday of both axis ends and of every lane time when the axis runs across midnight', async () => {
      renderTimeline(storyAt('24h'), { range: '24h' })
      // The ends are the same time of day, so only the weekday tells them apart.
      expect(screen.getByText('Sun 14:05Z')).toBeInTheDocument()
      expect(screen.getByText('Mon 14:05Z')).toBeInTheDocument()
      expect(list()).toHaveAccessibleDescription(
        'Last 24 hours, Sunday 14:05 to Monday 14:05. Times are UTC.',
      )
      for (const name of names()) {
        expect(name).toMatch(/(started|resolved at) (Sunday|Monday) \d\d:\d\d/)
      }
      expect(
        lane(/^ath-api: warning incident, started Monday 10:55, resolved after 22 minutes/),
      ).toBeInTheDocument()
    })

    it('writes no weekday while the whole axis is on one day', async () => {
      renderTimeline(storyAt('6h'))
      expect(screen.queryByText(/^(Sun|Mon) /)).not.toBeInTheDocument()
      for (const name of names()) expect(name).not.toMatch(/Sunday|Monday/)
    })

    it("writes the axis ends and the lane names in the operator's local time", async () => {
      window.localStorage.setItem('sentinel.prefs.v1', JSON.stringify({ tz: 'local' }))
      renderTimeline(storyAt('6h'))
      expect(screen.getByText(formatTime(NOW - 360 * MINUTE, 'local', false))).toBeInTheDocument()
      expect(screen.getByText(formatTime(NOW, 'local', false))).toBeInTheDocument()
      expect(screen.queryByText(/Z$/)).not.toBeInTheDocument()
      expect(list()).toHaveAccessibleDescription(/Times are local\.$/)
    })

    it("keeps the log's 24px line height and its 7.5rem minimum, shared by the summary, the axis and the lanes, scrolling the rest", async () => {
      renderTimeline(storyAt('6h'))
      for (const item of lanes()) expect(item).toHaveClass('h-6')
      expect(list().parentElement).toHaveClass('overflow-y-auto')
      expect(list().closest('.min-h-30')).not.toBeNull()
    })

    it("lays the axis row out in the lanes' columns, with more room for the name in a wide panel", async () => {
      const { container } = renderTimeline(storyAt('6h'))
      const axisRow = container.querySelector('div[aria-hidden="true"].grid')
      expect(axisRow).not.toBeNull()
      for (const row of [axisRow, ...lanes()]) {
        for (const token of LANE_COLUMNS.split(' ')) expect(row).toHaveClass(token)
      }
      const nameColumn = (variant: string) =>
        LANE_COLUMNS.split(' ').find((token) => token.startsWith(`${variant}:grid-cols-[`))
      expect(nameColumn('@lg')).toMatch(/\[10rem_/)
      expect(nameColumn('@max-sm')).toMatch(/\[4rem_/)
    })

    it('draws nothing that animates', async () => {
      const { container } = renderTimeline(storyAt('6h'))
      expect(container.querySelector('[class*="animate-"]')).toBeNull()
    })
  })

  describe('a lane', () => {
    it('shows an ongoing critical incident as a diamond, a solid bar that stays open, and the word ONGOING with its duration', async () => {
      renderTimeline(storyAt('6h'))
      const item = lane(PIR_VPN)
      expect(within(item).getByText('pir-vpn')).toBeInTheDocument()
      expect(glyphs(item)).toEqual(['critical'])
      expect(part(item, 'open-end')).not.toBeNull()
      expect(bar(item)).toHaveClass(STATUS_EDGE.critical)
      expect(within(item).getByText('ONGOING')).toBeInTheDocument()
      expect(within(item).getByText('12m')).toBeInTheDocument()
      expect(within(item).queryByText('RESOLVED')).not.toBeInTheDocument()
    })

    it('draws a warning as a triangle in the warning colors', async () => {
      renderTimeline(storyAt('6h'))
      const item = lane(MUC_VPN)
      expect(glyphs(item)).toEqual(['warning'])
      expect(bar(item)).toHaveClass(STATUS_EDGE.warning)
    })

    it('shows a resolved incident as a mark at each end of a tinted bar, and the word RESOLVED with its duration', async () => {
      renderTimeline(storyAt('6h'))
      const item = lane(ATH_API)
      expect(glyphs(item)).toEqual(['warning', 'healthy'])
      expect(part(item, 'open-end')).toBeNull()
      expect(bar(item)).toHaveClass(STATUS_TINT.warning)
      expect(bar(item)).not.toHaveClass(STATUS_EDGE.warning)
      expect(within(item).getByText('RESOLVED')).toBeInTheDocument()
      expect(within(item).getByText('22m')).toBeInTheDocument()
      expect(within(item).queryByText('ONGOING')).not.toBeInTheDocument()
    })

    it('tells ongoing from resolved by the end of the bar and by the word, not by color', async () => {
      renderTimeline(storyAt('6h'))
      const ongoing = lane(PIR_VPN)
      const resolved = lane(ATH_API)
      expect(part(ongoing, 'open-end')).not.toBeNull()
      expect(glyphs(resolved).at(-1)).toBe('healthy')
      expect(ongoing.textContent).toContain('ONGOING')
      expect(resolved.textContent).toContain('RESOLVED')
    })

    it('puts the bar between the start and the end of the incident on the axis', async () => {
      renderTimeline(storyAt('6h'))
      // 08:05:12 to 14:05:12: 10:55:12 is 170 of 360 minutes in, 11:17:12 is 192.
      expect(bar(lane(ATH_API)).style).toMatchObject({ left: '47.22%', width: '6.11%' })
    })

    it('runs an ongoing bar to the right edge', async () => {
      renderTimeline(storyAt('6h'))
      const { left, width } = bar(lane(PIR_VPN)).style
      expect(parseFloat(left) + parseFloat(width)).toBeCloseTo(100, 1)
    })

    it('says nothing of an acknowledgement in its name', async () => {
      renderTimeline(storyAt('6h'))
      expect(lane(HC_BKP)).toBeInTheDocument()
      expect(names().join(' ')).not.toMatch(/acknowledg/i)
    })

    it('is named by one sentence, with the drawing hidden from assistive technology', async () => {
      renderTimeline(storyAt('6h'))
      const item = lane(ATH_API)
      expect(item).toHaveAccessibleName(ATH_API)
      // The bar is a plain box, so only the track around it can hide it.
      expect(bar(item).closest('[aria-hidden="true"]')).not.toBeNull()
      for (const svg of item.querySelectorAll('svg')) {
        expect(svg.closest('[aria-hidden="true"]')).not.toBeNull()
      }
    })

    it('sits further right on a longer axis, where the same minutes are a smaller share', async () => {
      const events = storyAt('24h')
      const leftOn = (range: RangeKey) => {
        const { unmount } = renderTimeline(events, { range })
        const left = parseFloat(bar(lane(/^pir-vpn: critical incident/)).style.left)
        unmount()
        return left
      }
      expect(leftOn('1h')).toBeCloseTo(79.4, 1)
      expect(leftOn('24h')).toBeCloseTo(99.1, 1)
    })
  })

  describe('range clipping', () => {
    it('cuts an incident that began before the range at the left edge, with a marker, and does not invent its start or severity', async () => {
      // Four hours on, a 24h window starts between the day before's orthanc failing (17:55) and recovering (18:25).
      const later = NOW + 240 * MINUTE
      renderTimeline(storyAt('24h', later), { range: '24h', now: later })
      const item = lane(
        'orthanc@hc-pacs-01: incident that began before the last 24 hours, resolved at Sunday 18:25',
      )
      expect(item).toHaveAttribute('data-clipped', 'true')
      expect(part(item, 'cut-off')).not.toBeNull()
      expect(glyphs(item)).toEqual(['healthy'])
      expect(bar(item).style.left).toBe('0%')
      expect(within(item).getByText('RESOLVED')).toBeInTheDocument()
      expect(within(item).getByText('—')).toBeInTheDocument()
    })

    it('cuts the bar of an incident that started before the axis does, and keeps its severity mark and start', async () => {
      // The events cover 6h, the axis only 15 minutes: receipt-printer failed at 13:24.
      renderTimeline(storyAt('6h'), { range: '15m' })
      const item = lane(
        'receipt-printer@muc-pos-02: critical incident, started 13:24, ongoing for 41 minutes',
      )
      expect(item).toHaveAttribute('data-clipped', 'true')
      expect(part(item, 'cut-off')).not.toBeNull()
      expect(glyphs(item)).toEqual(['critical'])
      expect(bar(item).style.left).toBe('0%')
    })

    it('does not cut an incident that starts inside the axis', async () => {
      renderTimeline(storyAt('6h'))
      for (const item of lanes()) expect(item).not.toHaveAttribute('data-clipped')
    })

    it('keeps an incident that ended before the axis at the left edge, with no length', () => {
      renderTimeline(
        [
          event('f', '13:00:00', 'critical', 'pir-vpn', 'down'),
          event('r', '13:10:00', 'healthy', 'pir-vpn', 'up', 'f'),
        ],
        { range: '15m' },
      )
      expect(bar(lanes()[0] as HTMLElement).style).toMatchObject({ left: '0%', width: '0%' })
    })
  })

  describe('details', () => {
    it('opens a tooltip on keyboard focus with the times, the duration, the severity and both messages', async () => {
      const user = userEvent.setup()
      renderTimeline(storyAt('6h'))
      act(() => lane(ATH_API).focus())
      const tooltip = screen.getByRole('tooltip')
      const rows = [...tooltip.querySelectorAll('dl > div')].map((row) => row.textContent)
      expect(rows).toEqual([
        'Severitywarning',
        'Started10:55:12Z',
        'Recovered11:17:12Z',
        'Duration22m',
        'Openinglatency 188 ms, above 150 ms limit',
        'Recoveryback to baseline (12 ms)',
      ])
      expect(lane(ATH_API)).toHaveAccessibleDescription(/latency 188 ms/)
      await user.tab()
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })

    it('leads the tooltip times with the weekday when the axis runs across midnight', async () => {
      renderTimeline(storyAt('24h'), { range: '24h' })
      act(() => lane(/^ath-api: warning incident/).focus())
      const rows = [...screen.getByRole('tooltip').querySelectorAll('dl > div')].map(
        (row) => row.textContent,
      )
      expect(rows.slice(1, 3)).toEqual(['StartedMon 10:55:12Z', 'RecoveredMon 11:17:12Z'])
    })

    it('says ongoing, and no recovery, for an ongoing incident', async () => {
      renderTimeline(storyAt('6h'))
      act(() => lane(PIR_VPN).focus())
      const rows = [...screen.getByRole('tooltip').querySelectorAll('dl > div')].map(
        (row) => row.textContent,
      )
      expect(rows).toEqual([
        'Severitycritical',
        'Started13:52:50Z',
        'Recoveredongoing',
        'Duration12m so far',
        'OpeningTCP 443 timeout, probes failing',
      ])
    })

    it('says nothing of an acknowledgement, even for an incident with an info event under it', async () => {
      renderTimeline(storyAt('6h'))
      act(() => lane(HC_BKP).focus())
      expect(screen.getByRole('tooltip').textContent).not.toMatch(/acknowledg/i)
    })

    it('opens on hover as well', async () => {
      const user = userEvent.setup()
      renderTimeline(storyAt('6h'))
      await user.hover(lane(ATH_API))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('back to baseline (12 ms)')
    })

    it('keeps the information outside the tooltip: the lane names say when, how long and how it stands', async () => {
      renderTimeline(storyAt('6h'))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      expect(lane(ATH_API)).toHaveAccessibleName(
        'ath-api: warning incident, started 10:55, resolved after 22 minutes at 11:17',
      )
    })
  })

  describe('keyboard', () => {
    it('is one tab stop: the first lane, with the arrow keys, Home and End moving between lanes', async () => {
      const user = userEvent.setup()
      renderTimeline(storyAt('1h'))
      const rows = lanes()
      expect(rows.map((row) => row.getAttribute('tabindex'))).toEqual(
        rows.map((_, index) => (index === 0 ? '0' : '-1')),
      )

      await user.tab()
      expect(rows[0]).toHaveFocus()
      await user.keyboard('{ArrowDown}{ArrowDown}')
      expect(rows[2]).toHaveFocus()
      expect(rows.map((row) => row.getAttribute('tabindex')).indexOf('0')).toBe(2)

      await user.keyboard('{End}')
      expect(rows.at(-1)).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(rows.at(-1)).toHaveFocus()
      await user.keyboard('{ArrowUp}')
      expect(rows.at(-2)).toHaveFocus()
      await user.keyboard('{Home}')
      expect(rows[0]).toHaveFocus()
      await user.keyboard('{ArrowUp}')
      expect(rows[0]).toHaveFocus()
    })

    it('comes back to the lane it left when tabbing in again', async () => {
      const user = userEvent.setup()
      const events = storyAt('1h')
      renderApp(
        <>
          <button type="button">before</button>
          <IncidentTimeline view="1h" events={events} range="1h" now={NOW} />
        </>,
      )
      await user.tab()
      await user.tab()
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
      await user.tab({ shift: true })
      expect(screen.getByRole('button', { name: 'before' })).toHaveFocus()
      await user.tab()
      expect(lanes()[3]).toHaveFocus()
    })

    it('keeps one tab stop when the lanes shrink under the remembered one', async () => {
      const user = userEvent.setup()
      const many = storyAt('6h')
      // Every one of these is already among the lanes, so no pill takes the next tab stop.
      const few = many.slice(0, 6)
      const ui = (events: readonly SentinelEvent[]) => (
        <>
          <IncidentTimeline view="all:6h" events={events} range="6h" now={NOW} />
          <button type="button">after</button>
        </>
      )
      const { rerender } = renderApp(ui(many))
      expect(lanes()).toHaveLength(20)
      await user.tab()
      await user.keyboard('{End}')
      // The lanes are held while one has focus, so they shrink once focus has left.
      rerender(ui(few))
      await user.tab()
      expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
      const rows = lanes()
      expect(rows.length).toBeLessThan(20)
      expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toEqual([rows.at(-1)])
      await user.tab({ shift: true })
      expect(rows.at(-1)).toHaveFocus()
    })

    it('leaves other keys alone', async () => {
      const user = userEvent.setup()
      renderTimeline(storyAt('1h'))
      await user.tab()
      await user.keyboard('a{ArrowLeft}')
      expect(lanes()[0]).toHaveFocus()
    })
  })

  describe('when the events are only the newest of the range', () => {
    const cutOff = event('r', '14:31:00', 'healthy', 'pir-vpn', 'back', 'gone')

    it('says the opening of a recovery is not among the events, not that it began before the range', () => {
      renderTimeline([cutOff], { range: '24h', truncated: true })
      expect(lane(/^pir-vpn:/)).toHaveAccessibleName(
        'pir-vpn: incident whose opening is not among the events shown, resolved at Monday 14:31',
      )
      act(() => lane(/^pir-vpn:/).focus())
      const rows = [...screen.getByRole('tooltip').querySelectorAll('dl > div')].map(
        (row) => row.textContent,
      )
      expect(rows).toContain('Startednot in the events shown')
      expect(screen.queryByText(/before the last/)).not.toBeInTheDocument()
    })

    it('says the same recovery began before the range when the events cover all of it', () => {
      renderTimeline([cutOff], { range: '24h' })
      expect(lane(/^pir-vpn:/)).toHaveAccessibleName(
        'pir-vpn: incident that began before the last 24 hours, resolved at Monday 14:31',
      )
    })

    it('says in the summary that older events were not read', () => {
      renderTimeline([cutOff], { range: '1h', truncated: true })
      expect(screen.getByText('0 ongoing · 1 resolved · newest events only')).toBeInTheDocument()
    })

    it('does not claim an empty range when the events it read held no incident', () => {
      renderTimeline([event('i', '14:00:00', 'info', 'srv-01', 'agent updated')], {
        range: '1h',
        truncated: true,
      })
      expect(
        screen.getByText('No incidents among the newest events of the last 1h'),
      ).toBeInTheDocument()
      expect(screen.queryByText('No incidents in the last 1h')).not.toBeInTheDocument()
    })
  })

  describe('events repeated under one id', () => {
    const failure = () => event('f', '13:50:00', 'critical', 'pir-vpn', 'timeout')
    const sameKeyWarning = () => vi.spyOn(console, 'error').mockImplementation(() => {})

    it('draws one lane for an opening event that arrives twice, with no duplicate key', () => {
      const errors = sameKeyWarning()
      renderTimeline([failure(), failure()])
      expect(lanes()).toHaveLength(1)
      expect(names()).toEqual(['pir-vpn: critical incident, started 13:50, ongoing for 15 minutes'])
      expect(errors).not.toHaveBeenCalled()
    })

    it('draws one resolved lane for a recovery that arrives twice', () => {
      const errors = sameKeyWarning()
      const recovery = () => event('r', '14:00:00', 'healthy', 'pir-vpn', 'back', 'f')
      renderTimeline([failure(), recovery(), recovery(), failure()])
      expect(names()).toEqual([
        'pir-vpn: critical incident, started 13:50, resolved after 10 minutes at 14:00',
      ])
      expect(errors).not.toHaveBeenCalled()
    })

    it('does not resolve a lane with the recovery of a failure that followed from it', () => {
      renderTimeline([
        event('a', '13:50:00', 'critical', 'a-host', 'down'),
        event('b', '13:55:00', 'critical', 'b-host', 'down', 'a'),
        event('b-ok', '14:00:00', 'healthy', 'b-host', 'up', 'b'),
      ])
      expect(names()).toEqual(['a-host: critical incident, started 13:50, ongoing for 15 minutes'])
    })
  })

  describe('without evidence of an acknowledgement', () => {
    const events = () => [
      event('a', '13:50:00', 'critical', 'a-host', 'down'),
      {
        ...event('b-info', '13:55:00', 'info', 'b-host', 'B diagnostics collected', 'a'),
        message: 'B diagnostics collected; no acknowledgement.',
      },
      { ...event('a-info', '13:56:00', 'info', 'a-host', 'alert acknowledged by ops', 'a') },
    ]

    it('claims none in the visible lane, the tooltip or the accessible name', () => {
      renderTimeline([...events(), ...events()])
      expect(lanes()).toHaveLength(1)
      const item = lanes()[0] as HTMLElement
      expect(item.getAttribute('aria-label')).not.toMatch(/acknowledg/i)
      expect(item.textContent).not.toMatch(/acknowledg/i)
      act(() => item.focus())
      expect(screen.getByRole('tooltip').textContent).not.toMatch(/acknowledg/i)
    })

    it('agrees with the log, which lists those events as they were reported', () => {
      renderApp(<EventLog view="1h" events={events()} />)
      const log = screen.getByRole('log', { name: 'Recent events' })
      expect(within(log).getAllByRole('listitem')).toHaveLength(3)
      expect(log.textContent).toContain('alert acknowledged by ops')
    })
  })

  describe('no incidents', () => {
    it('says so in one line when the events hold only info', () => {
      renderTimeline([event('i', '14:00:00', 'info', 'srv-01', 'agent updated')], { range: '1h' })
      expect(screen.getByText('No incidents in the last 1h')).toBeInTheDocument()
      expect(screen.queryByRole('list')).not.toBeInTheDocument()
      expect(screen.queryByText(/ongoing ·/)).not.toBeInTheDocument()
    })

    it('says so when there are no events at all, with the range of the answer', () => {
      renderTimeline([], { range: '24h' })
      expect(screen.getByText('No incidents in the last 24h')).toBeInTheDocument()
    })

    it('is a recovery of nothing: a healthy event alone makes no incident', () => {
      renderTimeline([event('h', '14:00:00', 'healthy', 'srv-01', 'online')], { range: '1h' })
      expect(screen.getByText('No incidents in the last 1h')).toBeInTheDocument()
    })
  })

  describe('while it is being read', () => {
    const FAILURE = event('f', '14:00:00', 'critical', 'web-01', 'offline')
    const LATER = event('g', '14:03:00', 'warning', 'api-02', 'cpu 83%')

    it('follows new events at once when nobody is reading', () => {
      const { update } = renderTimeline([FAILURE], { range: '1h' })
      update([LATER, FAILURE])
      expect(lanes()).toHaveLength(2)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('freezes under the pointer behind an "N new" pill, then catches up when the pointer leaves', async () => {
      const user = userEvent.setup()
      const { update } = renderTimeline([FAILURE], { range: '1h' })
      await user.hover(list())

      update([LATER, FAILURE])
      expect(lanes()).toHaveLength(1)
      expect(screen.getByRole('button', { name: /1 new/i })).toBeInTheDocument()

      await user.unhover(list())
      expect(lanes()).toHaveLength(2)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('freezes the moment it measures against too: an ongoing duration holds still while it is read', async () => {
      const user = userEvent.setup()
      const { update } = renderTimeline([FAILURE], { range: '1h' })
      expect(lanes()[0]).toHaveAccessibleName(/ongoing for 5 minutes$/)
      await user.hover(list())

      update([FAILURE], NOW + 10 * MINUTE)
      expect(lanes()[0]).toHaveAccessibleName(/ongoing for 5 minutes$/)

      await user.unhover(list())
      expect(lanes()[0]).toHaveAccessibleName(/ongoing for 15 minutes$/)
    })

    it('holds a resolution back too, so an ongoing lane does not turn into a resolved one under the pointer', async () => {
      const user = userEvent.setup()
      const recovery = event('r', '14:04:00', 'healthy', 'web-01', 'online', 'f')
      const { update } = renderTimeline([FAILURE], { range: '1h' })
      await user.hover(list())
      update([recovery, FAILURE])
      expect(lanes()[0]).toHaveAttribute('data-incident', 'ongoing')
      expect(screen.getByRole('button', { name: /1 new/i })).toBeInTheDocument()
      await user.unhover(list())
      expect(lanes()[0]).toHaveAttribute('data-incident', 'resolved')
    })

    it('freezes while a lane has focus, and catches up on blur', async () => {
      const user = userEvent.setup()
      const { update } = renderTimeline([FAILURE], { range: '1h' })
      await user.tab()

      update([LATER, FAILURE])
      expect(lanes()).toHaveLength(1)
      expect(screen.getByRole('button', { name: /1 new/i })).toBeInTheDocument()

      act(() => (lanes()[0] as HTMLElement).blur())
      expect(lanes()).toHaveLength(2)
    })

    it('keeps the lane order still: a newer incident does not take the place under the pointer', async () => {
      const user = userEvent.setup()
      const { update } = renderTimeline([FAILURE], { range: '1h' })
      await user.hover(list())
      update([LATER, FAILURE])
      expect(names()).toEqual([expect.stringMatching(/^web-01: critical incident/)])
    })

    it('switches at once to a different range, even under the pointer', async () => {
      const user = userEvent.setup()
      const { rerender } = renderApp(
        <IncidentTimeline view="all:1h" events={[FAILURE]} range="1h" now={NOW} />,
      )
      await user.hover(list())
      rerender(<IncidentTimeline view="all:6h" events={[LATER, FAILURE]} range="6h" now={NOW} />)
      expect(lanes()).toHaveLength(2)
      expect(list()).toHaveAccessibleDescription(/^Last 6 hours/)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('shows the new events when the pill is pressed, with focus on the first lane', async () => {
      const user = userEvent.setup()
      const { update } = renderTimeline([FAILURE], { range: '1h' })
      await user.hover(list())
      update([LATER, FAILURE])
      // fireEvent, not user.click: moving user-event's pointer onto the pill would first fire a
      // pointer-out without a relatedTarget, which no browser does between two children.
      fireEvent.click(screen.getByRole('button', { name: /1 new/i }))
      expect(lanes()).toHaveLength(2)
      expect(lanes()[0]).toHaveFocus()
      expect(screen.queryByRole('button', { name: /new/i })).not.toBeInTheDocument()
    })
  })
})
