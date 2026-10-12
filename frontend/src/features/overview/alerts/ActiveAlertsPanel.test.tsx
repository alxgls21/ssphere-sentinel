import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Alert } from '@/api/types'
import { ShellContext, type ShellApi } from '@/app/shell'
import { createTestApi, renderApp } from '@/test/render'
import { HotkeyContext } from '@/app/hotkeys/mode'
import { AlertsProvider } from '../AlertsProvider'
import { ActiveAlertsPanel } from './ActiveAlertsPanel'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const alert = (
  id: string,
  severity: Alert['severity'],
  title: string,
  subject: string,
  ageMinutes: number,
): Alert => ({
  id,
  severity,
  state: 'active',
  title,
  message: `${title} on ${subject}`,
  subject: { kind: 'target', id, name: subject },
  rule: 'rule',
  siteId: null,
  since: minutesAgo(ageMinutes),
})

// Deliberately not in display order: the panel ranks them.
const FIVE: Alert[] = [
  alert('a4', 'warning', 'Disk over 80%', 'db-prod-01', 41),
  alert('a1', 'critical', 'Packet loss', 'acme-vpn:443', 9),
  alert('a5', 'warning', 'Latency high', 'cdn-edge:80', 95),
  alert('a2', 'critical', 'Container unhealthy', 'payments-api', 14),
  alert('a3', 'warning', 'CPU over 80%', 'api-02', 23),
]

const flashStatus = vi.fn()

const shell: ShellApi = {
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
  flashStatus,
}

const apiWith = (alerts: () => Promise<Alert[]> = async () => FIVE) =>
  createTestApi({ listAlerts: vi.fn(alerts) })

const renderPanel = (api = apiWith(), ui: ReactElement = <ActiveAlertsPanel />, route = '/') =>
  renderApp(
    <ShellContext.Provider value={shell}>
      <AlertsProvider>{ui}</AlertsProvider>
    </ShellContext.Provider>,
    { api, route },
  )

const region = () => screen.getByRole('region', { name: 'Active alerts' })

describe('ActiveAlertsPanel', () => {
  it('is panel [5]: a dashed, PLANNED region with the sample-data footer, not marked mock', async () => {
    renderPanel()
    expect(region()).toHaveAttribute('aria-keyshortcuts', '5')
    expect(region()).toHaveAttribute('data-planned', 'true')
    expect(region()).toHaveAccessibleDescription(/Sample data\./)
    expect(within(region()).getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('Sample data. Alert engine not implemented.')).toBeInTheDocument()
    expect(within(region()).queryByText(/^mock/)).not.toBeInTheDocument()
    await screen.findAllByRole('listitem')
  })

  it('takes its place in the Overview grid through className', async () => {
    renderPanel(apiWith(), <ActiveAlertsPanel className="col-span-4" />)
    expect(region()).toHaveClass('col-span-4')
    await screen.findAllByRole('listitem')
  })

  it('asks for active alerts only, in the topbar scope', async () => {
    const api = apiWith()
    renderPanel(api, <ActiveAlertsPanel />, '/?site=athens')
    await screen.findAllByRole('listitem')
    expect(api.listAlerts).toHaveBeenCalledWith({
      scope: { customerId: null, siteId: 'athens' },
      state: 'active',
      signal: expect.any(AbortSignal),
    })
  })

  describe('rows', () => {
    it('shows the three worst alerts: severity word, rule summary, entity, age', async () => {
      renderPanel()
      const rows = await screen.findAllByRole('listitem')
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.textContent)).toEqual([
        'CRITPacket lossacme-vpn:4439m',
        'CRITContainer unhealthypayments-api14m',
        'WARNCPU over 80%api-0223m',
      ])
    })

    it('uses the domain-free CRIT and WARN words with the status glyphs', async () => {
      renderPanel()
      const rows = await screen.findAllByRole('listitem')
      expect(rows.map((row) => row.querySelector('svg')?.getAttribute('data-status'))).toEqual([
        'critical',
        'critical',
        'warning',
      ])
    })

    it('counts every active alert in the header and the hidden ones in a "+N more" line', async () => {
      renderPanel()
      await screen.findAllByRole('listitem')
      expect(
        within(region().querySelector('header') as HTMLElement).getByText('5'),
      ).toBeInTheDocument()
      expect(screen.getByText('+2 more')).toBeInTheDocument()
    })

    it('has no "+N more" line when everything fits', async () => {
      renderPanel(apiWith(async () => FIVE.slice(0, 2)))
      await screen.findAllByRole('listitem')
      expect(screen.queryByText(/more$/)).not.toBeInTheDocument()
    })

    it('are not links: there is no alert screen to open', async () => {
      renderPanel()
      await screen.findAllByRole('listitem')
      expect(within(region()).queryByRole('link')).not.toBeInTheDocument()
    })
  })

  describe('acknowledge', () => {
    it('is disabled but still focusable, and says why', async () => {
      renderPanel()
      const ack = await screen.findByRole('button', { name: /Acknowledge/ })
      expect(ack).toHaveAttribute('aria-disabled', 'true')
      expect(ack).not.toBeDisabled()
      expect(ack).toHaveAttribute('aria-keyshortcuts', 'a')
      expect(ack).toHaveAccessibleDescription('Not implemented in the backend.')
      ack.focus()
      expect(ack).toHaveFocus()
    })

    it('explains itself in the status bar when clicked, without doing anything else', async () => {
      flashStatus.mockClear()
      const user = userEvent.setup()
      renderPanel()
      await user.click(await screen.findByRole('button', { name: /Acknowledge/ }))
      expect(flashStatus).toHaveBeenCalledExactlyOnceWith('Acknowledge: not implemented in backend')
    })

    it('answers the a key while the panel has focus', async () => {
      flashStatus.mockClear()
      const user = userEvent.setup()
      renderPanel()
      await screen.findAllByRole('listitem')
      region().focus()
      await user.keyboard('a')
      expect(flashStatus).toHaveBeenCalledExactlyOnceWith('Acknowledge: not implemented in backend')
    })

    it('leaves the a key to the global layer while a g chord is pending (g a goes to Alerts)', async () => {
      flashStatus.mockClear()
      renderPanel(
        apiWith(),
        <HotkeyContext.Provider value={{ mode: 'pending', pending: 'g' }}>
          <ActiveAlertsPanel />
        </HotkeyContext.Provider>,
      )
      await screen.findAllByRole('listitem')
      region().focus()
      const event = new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        bubbles: true,
        cancelable: true,
      })
      region().dispatchEvent(event)
      // Not taken: the engine still sees it, so the chord can complete.
      expect(event.defaultPrevented).toBe(false)
      expect(flashStatus).not.toHaveBeenCalled()
    })

    it('answers the a key from a focused control inside the panel, once', async () => {
      flashStatus.mockClear()
      const user = userEvent.setup()
      renderPanel()
      const ack = await screen.findByRole('button', { name: /Acknowledge/ })
      ack.focus()
      await user.keyboard('a')
      expect(flashStatus).toHaveBeenCalledTimes(1)
    })

    it('ignores the a key elsewhere, with a modifier, held down, or when single-key shortcuts are off', async () => {
      flashStatus.mockClear()
      const user = userEvent.setup()
      renderPanel(
        apiWith(),
        <>
          <ActiveAlertsPanel />
          <button type="button">elsewhere</button>
        </>,
      )
      await screen.findAllByRole('listitem')

      screen.getByRole('button', { name: 'elsewhere' }).focus()
      await user.keyboard('a')
      region().focus()
      await user.keyboard('{Control>}a{/Control}{Meta>}a{/Meta}{Alt>}a{/Alt}')
      await user.keyboard('{b}')
      expect(flashStatus).not.toHaveBeenCalled()
    })

    it('stays quiet when the operator turned single-key shortcuts off (WCAG 2.1.4)', async () => {
      flashStatus.mockClear()
      window.localStorage.setItem(
        'sentinel.prefs.v1',
        JSON.stringify({ singleKeyShortcuts: false }),
      )
      const user = userEvent.setup()
      renderPanel()
      await screen.findAllByRole('listitem')
      region().focus()
      await user.keyboard('a')
      expect(flashStatus).not.toHaveBeenCalled()
      // The button still explains itself: it is not a single-key shortcut.
      await user.click(screen.getByRole('button', { name: /Acknowledge/ }))
      expect(flashStatus).toHaveBeenCalledTimes(1)
    })
  })

  describe('states', () => {
    it('shows a skeleton only after a short delay, and no acknowledge button yet', async () => {
      const { container } = renderPanel(apiWith(() => new Promise<Alert[]>(() => {})))
      expect(region()).toHaveAttribute('aria-busy', 'true')
      expect(container.querySelector('.animate-skeleton')).toBeNull()
      await waitFor(() => expect(container.querySelectorAll('.animate-skeleton')).toHaveLength(3))
      expect(screen.queryByRole('button', { name: /Acknowledge/ })).not.toBeInTheDocument()
    })

    it('says there are no active alerts, without implying the engine checked', async () => {
      renderPanel(apiWith(async () => []))
      expect(await screen.findByText('No active alerts')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Acknowledge/ })).not.toBeInTheDocument()
      expect(region().querySelector('svg[data-status="healthy"]')).toBeNull()
      expect(screen.getByText('Sample data. Alert engine not implemented.')).toBeInTheDocument()
    })

    it('shows an inline error with Retry, and recovers', async () => {
      const user = userEvent.setup()
      let failing = true
      const api = apiWith(async () => {
        if (failing) throw new Error('boom')
        return FIVE
      })
      renderPanel(api)
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load active alerts')

      failing = false
      await user.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findAllByRole('listitem')).toHaveLength(3)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
