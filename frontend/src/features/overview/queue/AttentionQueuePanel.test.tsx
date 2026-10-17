import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { useLive } from '@/app/live'
import { NEXT_PROBLEM_EVENT } from '@/config/events'
import { createTestApi } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import { AttentionQueuePanel } from './AttentionQueuePanel'
import { makeItem, queueApi, referenceItems, renderQueue, resultOf } from './testing'
import { FOCUS_IDLE_MS, SETTLE_MS } from './useOrderLock'
import { SummaryContext } from '@/app/summary'

/** Shows where the router is, so a test can see where Enter went. */
function LocationProbe() {
  const { pathname, search } = useLocation()
  return <output data-testid="location">{`${pathname}${search}`}</output>
}

/** Stands in for the global r key, which refreshes through the live layer. */
function RefreshNow() {
  const { refresh } = useLive()
  return (
    <button type="button" onClick={refresh}>
      Refresh now
    </button>
  )
}

function Page() {
  return (
    <>
      <AttentionQueuePanel />
      <LocationProbe />
      <RefreshNow />
    </>
  )
}

afterEach(() => vi.restoreAllMocks())

const table = () => screen.getByRole('table', { name: 'Needs attention' })
const rows = () =>
  within(table())
    .getAllByRole('row')
    .filter((row) => row.getAttribute('aria-label')?.startsWith('Row '))
const labelOf = (row: HTMLElement | undefined) => row?.getAttribute('aria-label') ?? ''
const names = () => rows().map((row) => labelOf(row).split(', ')[2])
const focusRow = (index: number) => act(() => rows()[index]?.focus())
const focusedRow = () => labelOf(document.activeElement as HTMLElement)
const nextProblem = (direction: 1 | -1) =>
  act(() => {
    window.dispatchEvent(new CustomEvent(NEXT_PROBLEM_EVENT, { detail: { direction } }))
  })

/** A critical row that is new to the reference queue. */
const newCritical = () => makeItem({ id: 'srv-new', name: 'new-host', detail: 'offline' })

async function renderLoaded(items = referenceItems(), hiddenIdle = 0) {
  const queue = queueApi(resultOf(items, hiddenIdle))
  const view = renderQueue(<Page />, { api: queue.api })
  await screen.findByRole('table', { name: 'Needs attention' })
  return { ...queue, ...view }
}

describe('the table', () => {
  it('draws the rows in the order the API gave, as a real table', async () => {
    await renderLoaded()
    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent?.replace(/\s+/g, ' ')),
    ).toEqual(['SEV', 'ENTITY', 'DETAIL', 'SITE', 'AGE'])
    expect(names()).toEqual([
      'srv edge-gw-02',
      'ctr acme-proxy',
      'ctr payments-api',
      'ctr redis-cache',
      'ctr worker-3',
      'srv edge-gw-01',
      'ctr cdn-edge',
      'srv api-02',
      'srv db-prod-01',
    ])
  })

  it('gives each row a label that reads the whole line', async () => {
    await renderLoaded()
    expect(labelOf(rows()[1])).toBe(
      'Row 2 of 9, critical, ctr acme-proxy, dead, on edge-gw-02, Acme Athens-DC, 9 minutes',
    )
    expect(labelOf(rows()[7])).toBe(
      'Row 8 of 9, warning, srv api-02, cpu 82%, warn at 80, Globex Thess-1, age unavailable',
    )
  })

  it('shows the domain word, kind, name, detail, site and age in the cells', async () => {
    await renderLoaded()
    const cells = within(rows()[1] as HTMLElement).getAllByRole('cell')
    expect(cells.map((cell) => cell.textContent)).toEqual([
      'DEAD',
      'ctr acme-proxy',
      'dead · on edge-gw-02',
      'Acme / Athens-DC',
      '9m',
    ])
  })

  it('draws a 2px severity edge and the selection chevron on the first row only', async () => {
    const { container } = await renderLoaded()
    expect(rows()[0]?.querySelector('.w-0\\.5')).toBeInTheDocument()
    expect(rows().every((row) => row.querySelector('.w-0\\.5'))).toBe(true)
    expect(container.querySelectorAll('svg.lucide-chevron-right')).toHaveLength(1)
    expect(rows()[0]?.querySelector('svg.lucide-chevron-right')).toBeInTheDocument()
  })

  it('marks an age that does not exist with an em dash that says why', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    const dash = within(rows()[7] as HTMLElement).getByText('—')
    expect(within(rows()[7] as HTMLElement).getByText('no history')).toBeInTheDocument()
    await user.hover(dash)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/No history/)
  })

  it('hides the SITE column when no row has a site', async () => {
    await renderLoaded(
      referenceItems().map((item) => ({ ...item, customerName: undefined, siteName: undefined })),
    )
    expect(screen.queryByRole('columnheader', { name: /SITE/ })).not.toBeInTheDocument()
    expect(within(rows()[0] as HTMLElement).getAllByRole('cell')).toHaveLength(4)
  })
})

describe('the panel', () => {
  it('is region 1 with the count, the scope and a quiet source tag', async () => {
    await renderLoaded()
    const region = screen.getByRole('region', { name: 'Needs attention' })
    expect(region).toHaveAttribute('aria-keyshortcuts', '1')
    expect(within(region).getByText('9')).toBeInTheDocument()
    expect(within(region).getByText('NOW')).toBeInTheDocument()
    expect(within(region).getByText('mock · 3600s')).toBeInTheDocument()
    expect(region).not.toHaveAttribute('data-planned')
  })

  it('counts the problems it cannot list and says where all of them are', async () => {
    const queue = queueApi({ ...resultOf(referenceItems()), omitted: 41 })
    renderQueue(<Page />, { api: queue.api })
    await screen.findByRole('table', { name: 'Needs attention' })
    const region = screen.getByRole('region', { name: 'Needs attention' })
    // 9 listed and 41 that exist but are not in the rows the console API returns.
    expect(within(region).getByText('50')).toBeInTheDocument()
    expect(within(region).getByText(/41 more need attention and are not listed/)).toBeVisible()
    expect(within(region).getByRole('link', { name: 'Servers' })).toHaveAttribute(
      'href',
      '/servers',
    )
    expect(within(region).getByRole('link', { name: 'Docker' })).toHaveAttribute('href', '/docker')
    expect(within(region).getByRole('link', { name: 'Network' })).toHaveAttribute(
      'href',
      '/network',
    )
  })

  it('lists a probe target among the rows, as a net row that opens its own page', async () => {
    const target = makeItem({
      kind: 'target',
      id: 'tgt-1',
      name: 'pir-gateway',
      stateLabel: 'FAILING',
      detail: 'ICMP 10.20.0.1 · latest measurements all failed',
      ageBasis: 'last-measured',
    })
    await renderLoaded([target, ...referenceItems().slice(0, 2)])
    const row = screen.getByText('pir-gateway').closest('tr') as HTMLElement
    expect(row).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/^Row 1 of 3, critical, net pir-gateway, ICMP 10\.20\.0\.1/),
    )
    expect(within(row).getByText('FAILING')).toBeInTheDocument()
  })

  it('says nothing about omitted rows when the queue is whole', async () => {
    await renderLoaded()
    expect(screen.queryByText(/not listed/)).toBeNull()
    expect(screen.getByText(/j\/k move/)).toBeInTheDocument()
  })

  it('moves focus to the selected row when the panel itself is focused (digit key 1)', async () => {
    await renderLoaded()
    act(() => screen.getByRole('region', { name: 'Needs attention' }).focus())
    expect(focusedRow()).toBe(labelOf(rows()[0]))
  })

  it('lists the keys in the footer', async () => {
    await renderLoaded()
    expect(screen.getByText('j/k move · Enter open · y copy · f filter')).toBeInTheDocument()
  })
})

describe('an offline server', () => {
  /** The reference queue with its first row (a server) flagged as offline. */
  const withOffline = () =>
    referenceItems().map((item, index) => (index === 0 ? { ...item, offline: true } : item))

  it('shows the offline indicator and the word OFFLINE, apart from the CRIT rows', async () => {
    await renderLoaded(withOffline())
    const tag = within(rows()[0] as HTMLElement)
      .getByText('OFFLINE')
      .closest('[data-status]')
    expect(tag).toHaveAttribute('data-status', 'offline')
    expect(tag?.querySelector('svg')).toHaveAttribute('data-status', 'offline')
    expect(tag).toHaveClass('bg-offline-tint', 'text-offline')
    // Another critical row keeps the critical indicator.
    const down = within(rows()[1] as HTMLElement)
      .getByText('DEAD')
      .closest('[data-status]')
    expect(down).toHaveAttribute('data-status', 'critical')
  })

  it('keeps the critical severity edge', async () => {
    await renderLoaded(withOffline())
    const edge = rows()[0]?.querySelector('.w-0\\.5')
    expect(edge).toHaveClass('bg-critical')
    expect(edge?.className).not.toContain('offline')
  })

  it('is read as offline, with the rest of its line', async () => {
    await renderLoaded(withOffline())
    expect(labelOf(rows()[0])).toBe(
      'Row 1 of 9, offline, srv edge-gw-02, offline, last heartbeat 6m ago, Acme Athens-DC, 6 minutes',
    )
  })

  it('stays in the CRIT count and the CRIT filter', async () => {
    const user = userEvent.setup()
    await renderLoaded(withOffline())
    expect(screen.getByRole('button', { name: 'CRIT 4' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'CRIT 4' }))
    expect(names()).toEqual([
      'srv edge-gw-02',
      'ctr acme-proxy',
      'ctr payments-api',
      'ctr redis-cache',
    ])
    expect(within(rows()[0] as HTMLElement).getByText('OFFLINE')).toBeInTheDocument()
  })

  it('copies its row with the offline word', async () => {
    const user = userEvent.setup()
    const { shell } = await renderLoaded(withOffline())
    focusRow(0)
    await user.keyboard('y')
    await waitFor(() => expect(shell.flashStatus).toHaveBeenCalledWith('Copied row'))
    expect(await navigator.clipboard.readText()).toBe(
      'OFFL srv edge-gw-02 | offline · last heartbeat 6m ago | Acme / Athens-DC | 6m',
    )
  })
})

describe('filter', () => {
  it('has ALL, CRIT and WARN chips with counts', async () => {
    await renderLoaded()
    const group = screen.getByRole('group', { name: 'Filter by severity' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['ALL', 'CRIT 4', 'WARN 5'])
    expect(screen.getByRole('button', { name: 'ALL' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('filters with the chips and returns to ALL when the chip is pressed again', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(screen.getByRole('button', { name: 'CRIT 4' }))
    expect(rows()).toHaveLength(4)
    expect(labelOf(rows()[3])).toMatch(/^Row 4 of 4, critical/)
    expect(screen.getByRole('button', { name: 'CRIT 4' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'WARN 5' }))
    expect(rows()).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: 'WARN 5' }))
    expect(rows()).toHaveLength(9)
    expect(screen.getByRole('button', { name: 'ALL' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('cycles ALL, CRIT, WARN with the f key while the table has focus', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    focusRow(0)
    const pressed = () =>
      screen
        .getAllByRole('button', { pressed: true })
        .map((chip) => chip.textContent?.replace(/\s*\d+$/, ''))
    await user.keyboard('f')
    expect(pressed()).toEqual(['CRIT'])
    expect(rows()).toHaveLength(4)
    await user.keyboard('f')
    expect(pressed()).toEqual(['WARN'])
    await user.keyboard('f')
    expect(pressed()).toEqual(['ALL'])
    expect(rows()).toHaveLength(9)
  })

  it('keeps DOM focus in the table when the filter hides the focused row', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    focusRow(5)
    await user.keyboard('f')
    expect(rows()).toHaveLength(4)
    expect(document.activeElement).toBe(rows()[3])
  })

  it('clears the filter with Esc and leaves Esc alone when there is none', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    await renderLoaded()
    document.addEventListener('keydown', outer)
    focusRow(0)
    await user.keyboard('f')
    expect(rows()).toHaveLength(4)
    outer.mockClear()
    await user.keyboard('{Escape}')
    expect(rows()).toHaveLength(9)
    expect(outer).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(outer).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', outer)
  })

  it('says so, and offers the way out, when the filter leaves nothing', async () => {
    const user = userEvent.setup()
    await renderLoaded(referenceItems().filter((item) => item.severity === 'warning'))
    await user.click(screen.getByRole('button', { name: 'CRIT 0' }))
    expect(screen.getByText('No critical items')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all 5' }))
    expect(rows()).toHaveLength(5)
  })

  it('keeps keyboard focus when Show all makes its own button disappear', async () => {
    stubFocusVisible()
    const user = userEvent.setup()
    await renderLoaded(referenceItems().filter((item) => item.severity === 'warning'))
    await user.click(screen.getByRole('button', { name: 'CRIT 0' }))
    act(() => screen.getByRole('button', { name: 'Show all 5' }).focus())
    await user.keyboard('{Enter}')
    expect(rows()).toHaveLength(5)
    expect(document.activeElement).toBe(rows()[0])
  })
})

describe('keyboard', () => {
  it('is one tab stop: the selected row, with every other row at tabindex -1', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rows()[0]])
    expect(rows().filter((row) => row.tabIndex === -1)).toHaveLength(8)
    // Tab order: the filter chips, then the table's one stop.
    for (let i = 0; i < 4; i += 1) await user.tab()
    expect(document.activeElement).toBe(rows()[0])
  })

  it('moves the selection, and the tab stop with it, on j/k and the arrow keys', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    focusRow(0)
    await user.keyboard('j')
    expect(document.activeElement).toBe(rows()[1])
    expect(rows()[1]).toHaveAttribute('tabindex', '0')
    expect(rows()[0]).toHaveAttribute('tabindex', '-1')
    expect(rows()[1]).toHaveAttribute('aria-current', 'true')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(document.activeElement).toBe(rows()[3])
    await user.keyboard('k')
    expect(document.activeElement).toBe(rows()[2])
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(rows()[1])
  })

  it('stops at the ends and jumps with Home and End', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    focusRow(0)
    await user.keyboard('k')
    expect(document.activeElement).toBe(rows()[0])
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(rows()[8])
    await user.keyboard('j{ArrowDown}')
    expect(document.activeElement).toBe(rows()[8])
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(rows()[0])
  })

  it('selects a row by focusing it, and the chevron follows', async () => {
    const { container } = await renderLoaded()
    focusRow(4)
    expect(rows()[4]).toHaveAttribute('tabindex', '0')
    expect(container.querySelectorAll('svg.lucide-chevron-right')).toHaveLength(1)
    expect(rows()[4]?.querySelector('svg.lucide-chevron-right')).toBeInTheDocument()
  })

  it('opens the entity on its own screen with Enter', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    focusRow(0)
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('location')).toHaveTextContent('/servers?focus=srv-1')
  })

  it('opens each kind on the screen that owns it', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    focusRow(2)
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('location')).toHaveTextContent('/docker?focus=ctr-payments')
  })

  it('opens a row on click too, but not at the end of a text selection', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'acme-proxy',
    } as Selection)
    await user.click(rows()[1] as HTMLElement)
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
    selection.mockRestore()
    await user.click(rows()[1] as HTMLElement)
    expect(screen.getByTestId('location')).toHaveTextContent('/docker?focus=ctr-proxy')
  })

  it('puts focus back on the same row when the operator comes back', async () => {
    const user = userEvent.setup()
    function Away() {
      const navigate = useNavigate()
      return (
        <button type="button" onClick={() => void navigate(-1)}>
          Back
        </button>
      )
    }
    const queue = queueApi(resultOf(referenceItems()))
    renderQueue(
      <Routes>
        <Route path="/" element={<Page />} />
        <Route path="/docker" element={<Away />} />
      </Routes>,
      { api: queue.api },
    )
    await screen.findByRole('table', { name: 'Needs attention' })
    focusRow(1)
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Back' }))
    await screen.findByRole('table', { name: 'Needs attention' })
    await waitFor(() => expect(focusedRow()).toBe(labelOf(rows()[1])))
    expect(focusedRow()).toMatch(/^Row 2 of 9, critical, ctr acme-proxy/)
  })

  it('moves to the next and previous problem on the global event, skipping idle rows', async () => {
    const idle = makeItem({
      id: 'i-1',
      name: 'batch-job',
      kind: 'container',
      severity: 'idle',
      stateLabel: 'STOPPED',
    })
    await renderLoaded([...referenceItems().slice(0, 2), idle, ...referenceItems().slice(2)])
    nextProblem(1)
    expect(focusedRow()).toMatch(/^Row 2 of 10, critical, ctr acme-proxy/)
    nextProblem(1)
    expect(focusedRow()).toMatch(/^Row 4 of 10, critical, ctr payments-api/)
    nextProblem(-1)
    nextProblem(-1)
    expect(focusedRow()).toMatch(/^Row 1 of 10/)
    nextProblem(-1)
    expect(focusedRow()).toMatch(/^Row 10 of 10, warning, srv db-prod-01/)
    nextProblem(1)
    expect(focusedRow()).toMatch(/^Row 1 of 10/)
  })

  it('ignores the single letter keys when single-key shortcuts are off, but not the arrows', async () => {
    window.localStorage.setItem(
      'sentinel.prefs.v1',
      JSON.stringify({ tz: 'utc', singleKeyShortcuts: false, motion: 'system' }),
    )
    const user = userEvent.setup()
    await renderLoaded()
    focusRow(0)
    await user.keyboard('jf')
    expect(document.activeElement).toBe(rows()[0])
    expect(rows()).toHaveLength(9)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows()[1])
  })

  it('matches letter keys by physical key, so another keyboard layout still works', async () => {
    await renderLoaded()
    focusRow(0)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ξ', code: 'KeyJ' })
    expect(document.activeElement).toBe(rows()[1])
  })
})

describe('copy (y)', () => {
  const copied = 'CRIT ctr acme-proxy | dead · on edge-gw-02 | Acme / Athens-DC | 9m'

  it('copies the selected row as one line and confirms in the status bar', async () => {
    const user = userEvent.setup()
    const { shell } = await renderLoaded()
    focusRow(1)
    await user.keyboard('y')
    await waitFor(() => expect(shell.flashStatus).toHaveBeenCalledWith('Copied row'))
    expect(await navigator.clipboard.readText()).toBe(copied)
  })

  it('falls back to selecting text where the clipboard API is unavailable', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('insecure context'))
    let written = ''
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        written = (document.querySelector('textarea') as HTMLTextAreaElement).value
        return true
      }),
    })
    const { shell } = await renderLoaded()
    focusRow(1)
    await user.keyboard('y')
    await waitFor(() => expect(shell.flashStatus).toHaveBeenCalledWith('Copied row'))
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(written).toBe(copied)
    // The helper textarea is gone and the operator keeps their place.
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(rows()[1])
  })

  it('says so when nothing could be copied', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
    const { shell } = await renderLoaded()
    focusRow(1)
    await user.keyboard('y')
    await waitFor(() => expect(shell.flashStatus).toHaveBeenCalledWith('Copy failed'))
  })
})

describe('idle rows', () => {
  const idleRow = makeItem({
    id: 'ctr-batch',
    kind: 'container',
    name: 'nightly-batch',
    severity: 'idle',
    stateLabel: 'STOPPED',
    detail: 'exited · on app-01',
  })

  function idleApi() {
    const listAttention = vi.fn<SentinelApi['listAttention']>(async ({ includeIdle } = {}) =>
      includeIdle ? resultOf([...referenceItems(), idleRow], 0) : resultOf(referenceItems(), 1),
    )
    return { listAttention, api: createTestApi({ listAttention }) }
  }

  it('hides them behind a footer toggle and shows them on request', async () => {
    const user = userEvent.setup()
    const { api, listAttention } = idleApi()
    renderQueue(<Page />, { api })
    await screen.findByRole('table', { name: 'Needs attention' })
    expect(rows()).toHaveLength(9)
    expect(listAttention).toHaveBeenLastCalledWith(expect.objectContaining({ includeIdle: false }))

    await user.click(screen.getByRole('button', { name: '+1 hidden (idle)' }))
    await waitFor(() => expect(rows()).toHaveLength(10))
    expect(listAttention).toHaveBeenLastCalledWith(expect.objectContaining({ includeIdle: true }))
    expect(labelOf(rows()[9])).toBe(
      'Row 10 of 10, idle, ctr nightly-batch, exited, on app-01, Acme Athens-DC, 6 minutes',
    )
    // Idle rows are shown, not counted: the header still says 9.
    expect(
      within(screen.getByRole('region', { name: 'Needs attention' })).getByText('9'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hide idle' }))
    await waitFor(() => expect(rows()).toHaveLength(9))
  })

  it('shows no toggle when nothing is hidden', async () => {
    await renderLoaded(referenceItems(), 0)
    expect(screen.queryByRole('button', { name: /hidden \(idle\)/ })).not.toBeInTheDocument()
  })
})

describe('states', () => {
  afterEach(() => vi.useRealTimers())

  it('says so, with the time, when nothing needs attention', async () => {
    const queue = queueApi(resultOf([], 3))
    renderQueue(<Page />, { api: queue.api })
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument()
    expect(screen.getByText('Checked 14:05:12Z')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // The hidden idle rows are still one toggle away.
    expect(screen.getByRole('button', { name: '+3 hidden (idle)' })).toBeInTheDocument()
  })

  it('does not claim health when nothing is monitored at all', async () => {
    const zero = { healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 }
    const summary = {
      generatedAt: '2026-10-12T14:05:12Z',
      servers: { total: 0, online: 0, counts: zero },
      containers: { total: 0, running: 0, counts: zero },
      targets: { total: 0, up: 0, counts: zero, successTrend: [] },
      devices: { inInventory: 0, byType: { router: 0, switch: 0, firewall: 0, other: 0 } },
    }
    const resource = {
      status: 'success' as const,
      data: summary,
      error: null,
      isRefreshing: false,
      updatedAt: Date.now(),
      refetch: vi.fn(),
    }
    const queue = queueApi(resultOf([], 0))
    renderQueue(
      <SummaryContext.Provider value={resource}>
        <Page />
      </SummaryContext.Provider>,
      { api: queue.api },
    )
    expect(await screen.findByText('Nothing is monitored yet')).toBeInTheDocument()
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument()
  })

  it('shows skeleton rows at the real row height after a short delay', () => {
    vi.useFakeTimers()
    const api = createTestApi({ listAttention: () => new Promise(() => {}) })
    const { container } = renderQueue(<Page />, { api })
    expect(container.querySelector('.animate-skeleton')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(container.querySelectorAll('.h-\\(--row-h\\)')).toHaveLength(6)
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows an error with a way to retry', async () => {
    const user = userEvent.setup()
    const listAttention = vi
      .fn<SentinelApi['listAttention']>()
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValue(resultOf(referenceItems()))
    renderQueue(<Page />, { api: createTestApi({ listAttention }) })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load needs attention')
    expect(alert).toHaveTextContent('backend down')
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await screen.findByRole('table', { name: 'Needs attention' })
    expect(rows()).toHaveLength(9)
  })

  it('keeps the last rows on screen, under a banner, when a refresh fails', async () => {
    vi.useFakeTimers()
    const listAttention = vi
      .fn<SentinelApi['listAttention']>()
      .mockResolvedValueOnce(resultOf(referenceItems()))
      .mockRejectedValue(new Error('flaky'))
    renderQueue(<Page />, { api: createTestApi({ listAttention }), pollMs: 1000 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(rows()).toHaveLength(9)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(rows()).toHaveLength(9)
    expect(screen.getByText('Refresh failed')).toBeInTheDocument()
  })
})

describe('mobile cards', () => {
  it('offers View all N and shows every card once asked', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    // Rows past the fifth are hidden by the container query below 28rem.
    expect(rows()[4]).not.toHaveClass('@max-md:hidden')
    expect(rows()[5]).toHaveClass('@max-md:hidden')
    await user.click(screen.getByRole('button', { name: 'View all 9' }))
    expect(rows()[5]).not.toHaveClass('@max-md:hidden')
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument()
  })

  it('has no View all button for a short queue', async () => {
    await renderLoaded(referenceItems().slice(0, 5))
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument()
  })
})

describe('order lock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  async function lockedQueue() {
    const queue = queueApi(resultOf(referenceItems()))
    const view = renderQueue(<Page />, { api: queue.api, pollMs: 1000 })
    await advance(0)
    return { ...queue, ...view }
  }

  const pill = (name: string | RegExp) => screen.queryByRole('button', { name })

  it('keeps rows, order and values still while a row has focus, and queues the new snapshot', async () => {
    const { set, listAttention } = await lockedQueue()
    focusRow(0)
    const before = names()
    set(resultOf([newCritical(), ...referenceItems().slice(1)]))
    await advance(1000)
    expect(listAttention).toHaveBeenCalledTimes(2)
    expect(names()).toEqual(before)
    expect(pill('1 new incl. CRIT, apply (r)')).toBeInTheDocument()
    expect(rows()).toHaveLength(9)
  })

  it('applies at once on r, and the new critical row gets its one arrival outline', async () => {
    const { set, container } = await lockedQueue()
    focusRow(3)
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    expect(container.querySelector('.animate-crit-in')).toBeNull()

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'r', code: 'KeyR' })
    expect(rows()).toHaveLength(10)
    expect(names()[0]).toBe('srv new-host')
    expect(pill(/apply \(r\)/)).not.toBeInTheDocument()
    const outlined = container.querySelectorAll('.animate-crit-in')
    expect(outlined).toHaveLength(1)
    expect(rows()[0]).toContainElement(outlined[0] as HTMLElement)
  })

  it('applies from the pill, and says how many updates are waiting', async () => {
    const { set } = await lockedQueue()
    focusRow(0)
    set(
      resultOf([
        ...referenceItems().slice(2),
        makeItem({ id: 'srv-w', name: 'warn-host', severity: 'warning', stateLabel: 'DEGRADED' }),
      ]),
    )
    await advance(1000)
    const waiting = screen.getByRole('button', { name: '3 updates, apply (r)' })
    expect(waiting).toHaveAttribute('aria-keyshortcuts', 'r')
    fireEvent.click(waiting)
    expect(rows()).toHaveLength(8)
    expect(names()).toContain('srv warn-host')
  })

  it('keeps the selected row selected by id when the table changes under it', async () => {
    const { set } = await lockedQueue()
    focusRow(1)
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'r', code: 'KeyR' })
    expect(focusedRow()).toMatch(/^Row 3 of 10, critical, ctr acme-proxy/)
    expect(rows()[2]).toHaveAttribute('tabindex', '0')
  })

  it('hands focus to the neighbour when the focused row disappears', async () => {
    const { set } = await lockedQueue()
    focusRow(2)
    set(resultOf(referenceItems().filter((item) => item.name !== 'payments-api')))
    await advance(1000)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'r', code: 'KeyR' })
    expect(rows()).toHaveLength(8)
    expect(focusedRow()).toMatch(/^Row 3 of 8, critical, ctr redis-cache/)
  })

  it('applies 5 s after focus leaves the table', async () => {
    const { set } = await lockedQueue()
    focusRow(0)
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    expect(rows()).toHaveLength(9)
    act(() => (document.activeElement as HTMLElement).blur())
    expect(rows()).toHaveLength(9)
    await advance(SETTLE_MS)
    expect(rows()).toHaveLength(10)
    expect(pill(/apply \(r\)/)).not.toBeInTheDocument()
  })

  it('lets a keyboard user move from the table to the pill, press it and land back on the row', async () => {
    stubFocusVisible()
    const { set } = await lockedQueue()
    focusRow(2)
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    // Tab: focus leaves the table for the pill, and the update waits for them.
    const waiting = screen.getByRole('button', { name: /apply \(r\)/ })
    act(() => waiting.focus())
    await advance(1000)
    expect(rows()).toHaveLength(9)
    expect(waiting).toBeInTheDocument()
    // Enter on the button.
    fireEvent.click(waiting)
    expect(rows()).toHaveLength(10)
    expect(focusedRow()).toMatch(/^Row 4 of 10, critical, ctr payments-api/)
  })

  it('applies after 30 s without interaction, however long a row keeps focus', async () => {
    const { set } = await lockedQueue()
    focusRow(0)
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    await advance(FOCUS_IDLE_MS - 1000 - 1)
    expect(rows()).toHaveLength(9)
    await advance(1)
    expect(rows()).toHaveLength(10)
    expect(document.activeElement).toBe(rows()[1])
  })

  it('holds while the pointer moves over the table, and applies 5 s after it stops', async () => {
    const { set } = await lockedQueue()
    fireEvent.pointerMove(table())
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    expect(rows()).toHaveLength(9)
    expect(pill('1 new incl. CRIT, apply (r)')).toBeInTheDocument()

    await advance(SETTLE_MS - 1000 - 1)
    expect(rows()).toHaveLength(9)
    await advance(1)
    expect(rows()).toHaveLength(10)
  })

  it('does not hold at all when the operator is not in the table', async () => {
    const { set } = await lockedQueue()
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    expect(rows()).toHaveLength(10)
    expect(pill(/apply \(r\)/)).not.toBeInTheDocument()
  })

  it('answers a request to refresh at once, even with a row focused', async () => {
    const { set, listAttention } = await lockedQueue()
    focusRow(0)
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    expect(rows()).toHaveLength(9)

    // The refresh the operator asked for (key r reaches the live layer) is not held back either.
    const second = makeItem({ id: 'srv-2', name: 'second-host', kind: 'container' })
    set(resultOf([newCritical(), second, ...referenceItems()]))
    const calls = listAttention.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    expect(rows()).toHaveLength(10)
    await advance(0)
    expect(listAttention.mock.calls.length).toBe(calls + 1)
    expect(rows()).toHaveLength(11)
  })

  it('never holds the answer to a filter-like change of view (the idle toggle)', async () => {
    const listAttention = vi.fn<SentinelApi['listAttention']>(async ({ includeIdle } = {}) =>
      includeIdle
        ? resultOf(
            [
              ...referenceItems(),
              makeItem({ id: 'i', name: 'batch', kind: 'container', severity: 'idle' }),
            ],
            0,
          )
        : resultOf(referenceItems(), 1),
    )
    renderQueue(<Page />, { api: createTestApi({ listAttention }), pollMs: 1000 })
    await advance(0)
    // The pointer was over the table a moment ago, then went to the footer to press the toggle.
    fireEvent.pointerMove(table())
    fireEvent.click(screen.getByRole('button', { name: '+1 hidden (idle)' }))
    await advance(0)
    expect(rows()).toHaveLength(10)
  })

  it('tells a screen reader that updates are waiting, once', async () => {
    const { set, shell } = await lockedQueue()
    focusRow(0)
    set(resultOf([...referenceItems().slice(1)]))
    await advance(1000)
    expect(shell.announce).toHaveBeenCalledWith('Updates waiting. Press r to apply.')
    set(resultOf([...referenceItems().slice(2)]))
    await advance(1000)
    expect(shell.announce).toHaveBeenCalledTimes(1)
  })

  it('ignores r while single-key shortcuts are off, but the pill still works', async () => {
    window.localStorage.setItem(
      'sentinel.prefs.v1',
      JSON.stringify({ tz: 'utc', singleKeyShortcuts: false, motion: 'system' }),
    )
    const { set } = await lockedQueue()
    focusRow(0)
    set(resultOf([newCritical(), ...referenceItems()]))
    await advance(1000)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'r', code: 'KeyR' })
    expect(rows()).toHaveLength(9)
    fireEvent.click(screen.getByRole('button', { name: '1 new incl. CRIT, apply (r)' }))
    expect(rows()).toHaveLength(10)
  })
})
