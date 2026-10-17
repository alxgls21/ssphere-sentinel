import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import type { EntityIndex, EntityIndexItem } from '@/api/types'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { ShellContext, type ShellApi } from '@/app/shell'
import { useMockScenario } from '@/app/scenario'
import { useRange } from '@/app/viewState'
import { createTestApi, renderApp } from '@/test/render'
import { CommandPalette } from '.'

const entity = (
  item: Pick<EntityIndexItem, 'id' | 'kind' | 'name' | 'status'> & Partial<EntityIndexItem>,
): EntityIndexItem => ({ detail: '', ...item })

/** Six problems among servers and containers (one too many for the list), a stopped container, probe targets and a device the console API does not serve, and roll-ups. */
const INDEX: EntityIndex = {
  generatedAt: '2026-10-12T10:00:00.000Z',
  items: [
    entity({
      id: 's1',
      kind: 'server',
      name: 'edge-gw-01',
      detail: 'edge-gw-01.pir.example 10.20.0.1',
      status: 'healthy',
      siteName: 'Piraeus',
      customerName: 'Acme',
    }),
    entity({
      id: 's2',
      kind: 'server',
      name: 'edge-gw-02',
      detail: 'edge-gw-02.pir.example 10.20.0.2',
      status: 'critical',
      siteName: 'Piraeus',
      customerName: 'Acme',
    }),
    entity({
      id: 's3',
      kind: 'server',
      name: 'db-primary',
      detail: 'db-primary.ath.example 10.30.0.5',
      status: 'warning',
      siteName: 'Athens',
      customerName: 'Acme',
    }),
    entity({
      id: 's4',
      kind: 'server',
      name: 'cache-01',
      detail: 'cache-01.ath.example 10.30.0.9',
      status: 'unknown',
      siteName: 'Athens',
      customerName: 'Acme',
    }),
    entity({
      id: 'c1',
      kind: 'container',
      name: 'worker-restart',
      detail: 'ghcr.io/acme/worker:4 on db-primary',
      status: 'critical',
      siteName: 'Athens',
    }),
    entity({
      id: 'c2',
      kind: 'container',
      name: 'batch-nightly',
      detail: 'ghcr.io/acme/batch:1 on db-primary',
      status: 'idle',
    }),
    entity({
      id: 'c3',
      kind: 'container',
      name: 'queue-stuck',
      detail: 'ghcr.io/acme/queue:2 on db-primary',
      status: 'warning',
    }),
    entity({
      id: 'c4',
      kind: 'container',
      name: 'proxy-slow',
      detail: 'ghcr.io/acme/proxy:7 on edge-gw-02',
      status: 'warning',
    }),
    entity({
      id: 't1',
      kind: 'target',
      name: 'wan-uplink',
      detail: '203.0.113.7',
      status: 'warning',
    }),
    entity({
      id: 't2',
      kind: 'target',
      name: 'dns-probe',
      detail: '198.51.100.2:53',
      status: 'healthy',
    }),
    entity({
      id: 't3',
      kind: 'target',
      name: 'lb-health',
      detail: '203.0.113.9',
      status: 'warning',
    }),
    entity({
      id: 'd1',
      kind: 'device',
      name: 'sw-core-01',
      detail: '10.20.0.250',
      status: 'unknown',
      siteName: 'Piraeus',
    }),
    entity({
      id: 'site1',
      kind: 'site',
      name: 'Piraeus Port',
      detail: '2 servers, 1 targets',
      status: 'critical',
      siteName: 'Piraeus Port',
      customerName: 'Acme Corp',
    }),
    entity({
      id: 'cust1',
      kind: 'customer',
      name: 'Acme Corp',
      detail: '2 sites',
      status: 'warning',
      customerName: 'Acme Corp',
    }),
  ],
}

function spies() {
  return {
    flashStatus: vi.fn(),
    openShortcuts: vi.fn(),
    toggleSidebar: vi.fn(),
  }
}
type Spies = ReturnType<typeof spies>

/** The part of the shell the palette uses: open state it owns, everything else observable. */
function Shell({ spy, children }: { spy: Spies; children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const shell = useMemo<ShellApi>(
    () => ({
      sidebarCollapsed: false,
      toggleSidebar: spy.toggleSidebar,
      mobileNavOpen: false,
      setMobileNavOpen: () => {},
      paletteOpen,
      openPalette: () => setPaletteOpen(true),
      closePalette: () => setPaletteOpen(false),
      shortcutsOpen: false,
      openShortcuts: spy.openShortcuts,
      closeShortcuts: () => {},
      announce: () => {},
      flashStatus: spy.flashStatus,
    }),
    [paletteOpen, spy],
  )
  return (
    <ShellContext.Provider value={shell}>
      <button type="button" onClick={shell.openPalette}>
        Open palette
      </button>
      {children}
      <CommandPalette />
    </ShellContext.Provider>
  )
}

/** Makes the app state the palette changes readable. */
function Probe() {
  const { pathname, search } = useLocation()
  const { paused, refreshToken } = useLive()
  const { tz } = usePrefs()
  const [range] = useRange()
  const scenario = useMockScenario()
  return (
    <p data-testid="probe">
      {`${pathname}${search}|paused=${paused}|refresh=${refreshToken}|tz=${tz}|range=${range}|scenario=${scenario}`}
    </p>
  )
}

const probe = () => screen.getByTestId('probe').textContent

function setup({
  api = createTestApi({ getEntityIndex: vi.fn().mockResolvedValue(INDEX) }),
  route,
}: { api?: SentinelApi; route?: string } = {}) {
  const spy = spies()
  const user = userEvent.setup()
  renderApp(
    <Shell spy={spy}>
      <Probe />
    </Shell>,
    { api, route },
  )
  return { api, spy, user }
}

async function open(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Open palette' }))
  return screen.getByRole('dialog', { name: 'Command palette' })
}

/** Opens the palette and waits for the entity index to have arrived. */
async function openLoaded(user: UserEvent) {
  const dialog = await open(user)
  await within(dialog).findByRole('option', { name: /^edge-gw-02/ })
  return dialog
}

const combobox = () => screen.getByRole('combobox')
const options = () => screen.getAllByRole('option')
const groupNames = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('group')
    .map((group) => accessibleName(group))
const accessibleName = (element: HTMLElement) =>
  within(element).queryByText((_, node) => node?.tagName === 'LEGEND')?.textContent ?? ''
const titles = (group: HTMLElement) =>
  within(group)
    .getAllByRole('option')
    .map((option) => option.querySelector('span')?.textContent)
const group = (name: string) => within(screen.getByRole('listbox')).getByRole('group', { name })

describe('opening and closing', () => {
  it('is closed until the shell opens it, and does not fetch the entity index before', () => {
    const { api } = setup()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.getEntityIndex).not.toHaveBeenCalled()
  })

  it('opens a labelled modal dialog with the input focused', async () => {
    const { user } = setup()
    const dialog = await open(user)
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(combobox()).toHaveFocus()
    expect(combobox()).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
  })

  it('closes on Escape and returns focus to the invoker', async () => {
    const { user } = setup()
    const invoker = screen.getByRole('button', { name: 'Open palette' })
    await open(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoker).toHaveFocus()
  })

  it('closes when the backdrop is clicked, but not when the panel is', async () => {
    const { user } = setup()
    const dialog = await open(user)
    await user.click(screen.getByRole('listbox'))
    expect(dialog).toBeVisible()
    await user.click(dialog)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays open when a press starts in the field and ends on the backdrop (a text drag)', async () => {
    const { user } = setup()
    const dialog = await open(user)
    await user.type(combobox(), 'edge')
    fireEvent.mouseDown(combobox())
    fireEvent.mouseUp(dialog)
    fireEvent.click(dialog)
    expect(dialog).toBeVisible()
  })

  it('keeps focus in the field when a part of the panel that is not a control is pressed', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.click(screen.getByText('Problems'))
    expect(combobox()).toHaveFocus()
  })

  it('keeps Escape to itself, so it does not also reach the hotkey layer', async () => {
    const { user } = setup()
    await open(user)
    const onKey = vi.fn()
    document.addEventListener('keydown', onKey)
    await user.keyboard('{Escape}')
    document.removeEventListener('keydown', onKey)
    expect(onKey).not.toHaveBeenCalled()
  })

  it('starts empty every time it opens, and refreshes the index in the background', async () => {
    const { api, user } = setup()
    await openLoaded(user)
    await user.type(combobox(), '@edge')
    await user.keyboard('{Escape}')
    expect(api.getEntityIndex).toHaveBeenCalledTimes(1)

    await open(user)
    expect(combobox()).toHaveValue('')
    await waitFor(() => expect(api.getEntityIndex).toHaveBeenCalledTimes(2))
    // The previous index stays on screen while the new one loads.
    expect(screen.getByRole('option', { name: /^edge-gw-02/ })).toBeInTheDocument()
  })

  it('loads the index for the current scope', async () => {
    const { api, user } = setup({ route: '/?customer=acme&site=pir' })
    await open(user)
    await waitFor(() => expect(api.getEntityIndex).toHaveBeenCalled())
    expect(api.getEntityIndex).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { customerId: 'acme', siteId: 'pir' } }),
    )
  })
})

describe('empty query', () => {
  it('lists problems, go to, actions, mock scenario and planned, in that order', async () => {
    const { user } = setup()
    await openLoaded(user)
    expect(groupNames()).toEqual(['Problems', 'Go to', 'Actions', 'Mock scenario', 'Planned'])
  })

  it('shows the top five problems worst first, from servers and containers only', async () => {
    const { user } = setup()
    await openLoaded(user)
    // Critical, then warning, then unknown (cut off by the limit of five). The stopped container,
    // the probe targets, the SNMP device, the site and the customer never appear.
    expect(titles(group('Problems'))).toEqual([
      'edge-gw-02',
      'worker-restart',
      'db-primary',
      'queue-stuck',
      'proxy-slow',
    ])
    const first = within(group('Problems')).getAllByRole('option')[0]
    expect(first).toHaveTextContent('CRIT')
  })

  describe('with an offline server first in the index', () => {
    const withOffline: EntityIndex = {
      ...INDEX,
      items: [
        entity({
          id: 'off',
          kind: 'server',
          name: 'pir-fs-01',
          detail: 'pir-fs-01.internal 10.30.1.20',
          status: 'critical',
          offline: true,
        }),
        ...INDEX.items,
      ],
    }
    const openProblems = async () => {
      const { user } = setup({
        api: createTestApi({ getEntityIndex: vi.fn().mockResolvedValue(withOffline) }),
      })
      await openLoaded(user)
      return within(group('Problems')).getAllByRole('option')
    }

    it('tags it OFFL, with its own shape, where the others stay CRIT', async () => {
      const [offline, critical] = await openProblems()
      // The problems list ranks it as critical: ahead of the critical entities that came after it, before any warning.
      expect(titles(group('Problems'))).toEqual([
        'pir-fs-01',
        'edge-gw-02',
        'worker-restart',
        'db-primary',
        'queue-stuck',
      ])
      expect(critical?.querySelector('[data-status]')).toHaveAttribute('data-status', 'critical')
      expect(critical).toHaveTextContent('CRIT')
      expect(offline?.querySelector('[data-status]')).toHaveAttribute('data-status', 'offline')
      expect(offline?.querySelector('svg[data-status]')).toHaveAttribute('data-status', 'offline')
      expect(offline).toHaveTextContent('OFFL')
      expect(offline).not.toHaveTextContent('CRIT')
    })

    it('names the state in full for a screen reader, not by its tag', async () => {
      const [offline, critical] = await openProblems()
      expect(offline).toHaveAccessibleName(/^pir-fs-01 .* offline$/)
      expect(critical).toHaveAccessibleName(/^edge-gw-02 .* critical$/)
    })
  })

  it('lists the eight screens with their g-key hints and a PLAN tag on the planned ones', async () => {
    const { user } = setup()
    await openLoaded(user)
    const goTo = group('Go to')
    expect(titles(goTo)).toEqual([
      'Overview',
      'Servers',
      'Docker',
      'Network',
      'SNMP',
      'Topology',
      'Alerts',
      'Customers & Sites',
    ])
    expect(within(goTo).getByRole('option', { name: /^Servers/ })).toHaveTextContent(
      'Shortcut g then s',
    )
    const planned = within(goTo)
      .getAllByRole('option')
      .filter((option) => within(option).queryByText('Plan') !== null)
    expect(planned.map((option) => option.querySelector('span')?.textContent)).toEqual([
      'Topology',
      'Alerts',
    ])
  })

  it('offers the actions with their shortcut hints', async () => {
    const { user } = setup()
    await openLoaded(user)
    expect(titles(group('Actions'))).toEqual([
      'Pause updates',
      'Refresh now',
      'Next time range',
      'Switch to local time',
      'Turn off single-key shortcuts',
      'Reduce motion',
      'Collapse sidebar',
      'Copy link to this view',
      'Show shortcuts',
    ])
    expect(
      within(group('Actions')).getByRole('option', { name: /Pause updates/ }),
    ).toHaveTextContent('Shortcut p')
  })

  it('leaves out single-key hints while single-key shortcuts are off', async () => {
    window.localStorage.setItem('sentinel.prefs.v1', JSON.stringify({ singleKeyShortcuts: false }))
    const { user } = setup()
    await openLoaded(user)
    expect(screen.queryByText(/^Shortcut /)).not.toBeInTheDocument()
  })

  it('selects the first row and points the combobox at it', async () => {
    const { user } = setup()
    await openLoaded(user)
    const [first] = options()
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(combobox()).toHaveAttribute('aria-activedescendant', first?.id)
    expect(
      options().filter((option) => option.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1)
  })
})

describe('typing', () => {
  it('ranks by fuzzy score and breaks ties by severity: ed lists edge-gw-02 (CRIT) before edge-gw-01 (OK)', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), 'ed')
    const names = titles(group('Entities'))
    expect(names.indexOf('edge-gw-02')).toBeLessThan(names.indexOf('edge-gw-01'))
    expect(names.slice(0, 2)).toEqual(['edge-gw-02', 'edge-gw-01'])
  })

  it('matches addresses, hostnames, sites and customers, not only names', async () => {
    const { user } = setup()
    await openLoaded(user)

    await user.clear(combobox())
    await user.type(combobox(), '203.0.113.7')
    expect(titles(group('Entities'))).toContain('wan-uplink')

    await user.clear(combobox())
    await user.type(combobox(), 'pir.example')
    expect(titles(group('Entities'))).toEqual(expect.arrayContaining(['edge-gw-01', 'edge-gw-02']))

    await user.clear(combobox())
    await user.type(combobox(), 'acme')
    expect(titles(group('Sites and customers'))).toContain('Acme Corp')
  })

  it('shows the entity subtitle (kind, detail, site) and state tag', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), 'edge-gw-02')
    const [top] = options()
    expect(top).toHaveTextContent('server · edge-gw-02.pir.example 10.20.0.2 · Piraeus')
    expect(top).toHaveTextContent('CRIT')
  })

  it('puts the group holding the best match first', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), 'refresh')
    expect(groupNames()[0]).toBe('Actions')
    await user.clear(combobox())
    await user.type(combobox(), 'edge')
    expect(groupNames()[0]).toBe('Entities')
  })

  it('says so, and offers a way forward, when nothing matches', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), 'qqqqqq')
    expect(screen.getByText('No match. Try @ for entities')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(combobox()).toHaveAttribute('aria-expanded', 'false')
    expect(combobox()).not.toHaveAttribute('aria-activedescendant')
  })

  it('announces the result count politely, once typing settles', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), 'edge-gw-02')
    const count = options().length
    const status = screen.getAllByRole('status').find((node) => node.classList.contains('sr-only'))
    await waitFor(() =>
      expect(status).toHaveTextContent(`${count} ${count === 1 ? 'result' : 'results'}`),
    )
  })
})

describe('prefixes and scope chips', () => {
  const chip = (name: string) => screen.getByRole('button', { name })

  it('> narrows to actions, mock scenarios and planned items', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), '>')
    expect(groupNames()).toEqual(['Actions', 'Mock scenario', 'Planned'])
    expect(chip('Actions')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('All')).toHaveAttribute('aria-pressed', 'false')
  })

  it('@ lists entities, sites and customers worst first', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), '@')
    expect(groupNames()).toEqual(['Entities', 'Sites and customers'])
    expect(titles(group('Entities')).slice(0, 2)).toEqual(['edge-gw-02', 'worker-restart'])
    expect(chip('Entities')).toHaveAttribute('aria-pressed', 'true')
  })

  it('# lists only sites and customers', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), '#')
    expect(groupNames()).toEqual(['Sites and customers'])
    expect(titles(group('Sites and customers'))).toEqual(['Piraeus Port', 'Acme Corp'])
  })

  it('narrows a typed query to the prefix scope', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), '@serv')
    // "Servers" the screen matches "serv", but is not an entity.
    expect(screen.queryByRole('option', { name: /^Servers/ })).not.toBeInTheDocument()
    await user.clear(combobox())
    await user.type(combobox(), 'serv')
    expect(screen.getByRole('option', { name: /^Servers/ })).toBeInTheDocument()
  })

  it('? explains the prefixes, and choosing a row types it', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), '?')
    expect(groupNames()).toEqual(['Help'])
    await user.click(screen.getByRole('option', { name: /^Entities/ }))
    expect(combobox()).toHaveValue('@')
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(combobox()).toHaveFocus()
    expect(groupNames()).toEqual(['Entities', 'Sites and customers'])
  })

  it('Tab cycles the scope chips, Shift+Tab goes back, and the field keeps focus', async () => {
    const { user } = setup()
    await openLoaded(user)
    const pressed = () =>
      screen
        .getAllByRole('button', { pressed: true })
        .map((node) => node.textContent)
        .join()
    expect(pressed()).toBe('All')
    await user.tab()
    expect(pressed()).toBe('Go to')
    expect(groupNames()).toEqual(['Go to'])
    await user.tab()
    expect(pressed()).toBe('Entities')
    await user.tab()
    expect(pressed()).toBe('Actions')
    await user.tab()
    expect(pressed()).toBe('All')
    await user.tab({ shift: true })
    expect(pressed()).toBe('Actions')
    expect(combobox()).toHaveFocus()
  })

  it('replaces a typed prefix when a chip is chosen', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), '>pause')
    await user.click(chip('Go to'))
    expect(combobox()).toHaveValue('pause')
    expect(chip('Go to')).toHaveAttribute('aria-pressed', 'true')
    await user.click(chip('Go to'))
    expect(chip('All')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('keyboard', () => {
  const activeOption = () =>
    options().find((option) => option.getAttribute('aria-selected') === 'true')

  it('moves the active row with the arrows, wrapping at both ends', async () => {
    const { user } = setup()
    await openLoaded(user)
    const all = options()
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toBe(all[1])
    expect(combobox()).toHaveAttribute('aria-activedescendant', all[1]?.id)
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(activeOption()).toBe(all.at(-1))
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toBe(all[0])
  })

  it('moves with Ctrl+J and Ctrl+K', async () => {
    const { user } = setup()
    await openLoaded(user)
    const all = options()
    await user.keyboard('{Control>}j{/Control}')
    expect(activeOption()).toBe(all[1])
    await user.keyboard('{Control>}j{/Control}{Control>}k{/Control}')
    expect(activeOption()).toBe(all[1])
    await user.keyboard('{Control>}k{/Control}')
    expect(activeOption()).toBe(all[0])
  })

  it('keeps Ctrl+K to itself, so it moves up instead of reaching the shortcut that opens the palette', async () => {
    const { user } = setup()
    await openLoaded(user)
    const seen: string[] = []
    const record = (event: KeyboardEvent) => seen.push(event.code)
    document.addEventListener('keydown', record)
    await user.keyboard('{Control>}k{/Control}a')
    document.removeEventListener('keydown', record)
    // A plain key reaches the document, so the listener works; Ctrl+K never does.
    expect(seen).toContain('KeyA')
    expect(seen).not.toContain('KeyK')
  })

  it('keeps the active row when the list changes under it', async () => {
    let resolve: (index: EntityIndex) => void = () => {}
    const api = createTestApi({
      getEntityIndex: vi.fn(() => new Promise<EntityIndex>((done) => (resolve = done))),
    })
    const { user } = setup({ api })
    await open(user)
    // Loading: only screens and actions. Move to Servers, then let the index arrive.
    await user.keyboard('{ArrowDown}')
    expect(activeOption()).toHaveAccessibleName(/^Servers/)
    resolve(INDEX)
    await screen.findByRole('option', { name: /^edge-gw-02/ })
    expect(activeOption()).toHaveAccessibleName(/^Servers/)
  })

  it('moves the active row with the pointer without taking focus from the input', async () => {
    const { user } = setup()
    await openLoaded(user)
    const target = screen.getByRole('option', { name: /^Docker/ })
    await user.hover(target)
    expect(target).toHaveAttribute('aria-selected', 'true')
    expect(combobox()).toHaveAttribute('aria-activedescendant', target.id)
    await user.pointer({ keys: '[MouseLeft>]', target })
    expect(combobox()).toHaveFocus()
  })

  it('Enter on a screen navigates there, closes, and keeps the scope and range in the URL', async () => {
    const { user } = setup({ route: '/?range=6h&customer=acme' })
    await openLoaded(user)
    await user.type(combobox(), 'servers')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(probe()).toMatch(/^\/servers\?range=6h&customer=acme\|/)
  })

  it.each([
    // A server has a page of its own.
    ['edge-gw-02', '/servers/s2'],
    ['worker-restart', '/docker'],
    ['wan-uplink', '/network'],
    ['sw-core-01', '/snmp'],
    ['Piraeus Port', '/customers'],
    ['Acme Corp', '/customers'],
  ])('Enter on %s opens %s, the page or screen that owns it', async (name, path) => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), name)
    await user.keyboard('{Enter}')
    expect(probe()).toMatch(new RegExp(`^${path}\\|`))
  })

  it('clicking a row runs it', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.click(screen.getByRole('option', { name: /^Docker/ }))
    expect(probe()).toMatch(/^\/docker\|/)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does nothing on Enter when nothing matches', async () => {
    const { user } = setup()
    await openLoaded(user)
    await user.type(combobox(), 'qqqqqq{Enter}')
    expect(screen.getByRole('dialog')).toBeVisible()
  })
})

describe('actions', () => {
  async function run(user: UserEvent, name: RegExp) {
    await openLoaded(user)
    await user.click(screen.getByRole('option', { name }))
  }

  it('pauses and resumes live updates', async () => {
    const { user } = setup()
    await run(user, /^Pause updates/)
    expect(probe()).toContain('paused=true')
    await open(user)
    expect(screen.getByRole('option', { name: /^Resume updates/ })).toBeInTheDocument()
  })

  it('refreshes now', async () => {
    const { user } = setup()
    await run(user, /^Refresh now/)
    expect(probe()).toContain('refresh=1')
  })

  it('steps to the next time range and says which', async () => {
    const { user } = setup()
    await openLoaded(user)
    expect(screen.getByRole('option', { name: /^Next time range/ })).toHaveTextContent('1h to 6h')
    await user.click(screen.getByRole('option', { name: /^Next time range/ }))
    expect(probe()).toContain('range=6h')
  })

  it('switches between UTC and local time', async () => {
    const { user } = setup()
    await run(user, /^Switch to local time/)
    expect(probe()).toContain('tz=local')
    await open(user)
    expect(screen.getByRole('option', { name: /^Switch to UTC/ })).toBeInTheDocument()
  })

  it('turns single-key shortcuts off and on again (WCAG 2.1.4, reachable at every width)', async () => {
    const { user } = setup()
    const stored = () => JSON.parse(window.localStorage.getItem('sentinel.prefs.v1') ?? '{}')
    await run(user, /^Turn off single-key shortcuts/)
    await waitFor(() => expect(stored().singleKeyShortcuts).toBe(false))
    await open(user)
    // With them off the single-key hints must disappear: they would be lies.
    expect(
      screen.getByRole('option', { name: /^Turn on single-key shortcuts/ }),
    ).toBeInTheDocument()
    expect(
      within(group('Actions')).getByRole('option', { name: /Pause updates/ }),
    ).not.toHaveTextContent('Shortcut')
    await user.click(screen.getByRole('option', { name: /^Turn on single-key shortcuts/ }))
    await waitFor(() => expect(stored().singleKeyShortcuts).toBe(true))
  })

  it('forces reduced motion and gives the choice back', async () => {
    const { user } = setup()
    await run(user, /^Reduce motion/)
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-motion', 'reduce'))
    await open(user)
    await user.click(screen.getByRole('option', { name: /^Follow the system motion setting/ }))
    await waitFor(() => expect(document.documentElement).not.toHaveAttribute('data-motion'))
  })

  it('toggles the sidebar and opens the shortcut sheet through the shell', async () => {
    const { spy, user } = setup()
    await run(user, /^Collapse sidebar/)
    expect(spy.toggleSidebar).toHaveBeenCalledOnce()
    await open(user)
    await user.click(screen.getByRole('option', { name: /^Show shortcuts/ }))
    expect(spy.openShortcuts).toHaveBeenCalledOnce()
  })

  it('copies the link to this view and confirms in the status bar', async () => {
    const { spy, user } = setup()
    await run(user, /^Copy link to this view/)
    await waitFor(() => expect(spy.flashStatus).toHaveBeenCalledWith('Link to this view copied'))
    expect(await navigator.clipboard.readText()).toBe(window.location.href)
  })
})

describe('mock scenarios', () => {
  it('lists every scenario, marks the current one, and applies the chosen one', async () => {
    const { user } = setup()
    await openLoaded(user)
    const scenarios = group('Mock scenario')
    expect(titles(scenarios)).toEqual([
      'normal',
      'healthy',
      'partial',
      'stale',
      'slow',
      'loading',
      'empty',
      'error',
    ])
    expect(within(scenarios).getByRole('option', { name: /^normal/ })).toHaveTextContent('Current')
    expect(within(scenarios).getByRole('option', { name: /^error/ })).not.toHaveTextContent(
      'Current',
    )

    await user.click(within(scenarios).getByRole('option', { name: /^error/ }))
    // The scenario is URL state, like the range: the palette writes it through the router.
    expect(probe()).toContain('scenario=error')
    expect(probe()).toContain('mock=error')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('is absent when the data is not mock', async () => {
    const api = createTestApi({ source: 'http', getEntityIndex: vi.fn().mockResolvedValue(INDEX) })
    const { user } = setup({ api })
    await openLoaded(user)
    expect(groupNames()).not.toContain('Mock scenario')
  })
})

describe('planned items', () => {
  it('are listed disabled, with a PLANNED chip and a reason', async () => {
    const { user } = setup()
    await openLoaded(user)
    const planned = group('Planned')
    expect(titles(planned)).toEqual(['Acknowledge alert', 'Open topology', 'Create alert rule'])
    for (const option of within(planned).getAllByRole('option')) {
      expect(option).toHaveAttribute('aria-disabled', 'true')
      expect(option).toHaveTextContent('Planned')
    }
    expect(within(planned).getByRole('option', { name: /^Acknowledge alert/ })).toHaveTextContent(
      'The backend has no alert engine',
    )
  })

  it('stay selectable with the keyboard and explain themselves when run', async () => {
    const { spy, user } = setup()
    await openLoaded(user)
    await user.type(combobox(), 'acknowledge')
    const [top] = options()
    expect(top).toHaveAccessibleName(/^Acknowledge alert/)
    expect(top).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(spy.flashStatus).toHaveBeenCalledWith('Acknowledge alert: not implemented in backend')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('explain themselves when clicked, and change nothing', async () => {
    const { spy, user } = setup()
    await openLoaded(user)
    await user.click(screen.getByRole('option', { name: /^Create alert rule/ }))
    expect(spy.flashStatus).toHaveBeenCalledWith('Create alert rule: not implemented in backend')
    expect(probe()).toMatch(/^\/\|/)
  })
})

describe('entity index states', () => {
  it('shows skeleton lines where the problems will go while loading, with navigation usable', async () => {
    const api = createTestApi({ getEntityIndex: vi.fn(() => new Promise<EntityIndex>(() => {})) })
    const { user } = setup({ api })
    const dialog = await open(user)
    expect(dialog.querySelectorAll('[aria-hidden="true"].animate-skeleton')).toHaveLength(3)
    expect(screen.getByText('Problems')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('loading entities')
    expect(groupNames()).toEqual(['Go to', 'Actions', 'Mock scenario', 'Planned'])
    await user.type(combobox(), 'network{Enter}')
    expect(probe()).toMatch(/^\/network\|/)
  })

  it('shows a quiet inline error when it fails, and keeps navigation and actions', async () => {
    const api = createTestApi({ getEntityIndex: vi.fn().mockRejectedValue(new Error('503')) })
    const { user } = setup({ api })
    const dialog = await open(user)
    await within(dialog).findByText('Entity search unavailable')
    expect(groupNames()).toEqual(['Go to', 'Actions', 'Mock scenario', 'Planned'])
    expect(screen.queryByText(/^No match/)).not.toBeInTheDocument()

    await user.type(combobox(), 'docker{Enter}')
    expect(probe()).toMatch(/^\/docker\|/)
  })

  it('retries from the inline error, and the problems appear', async () => {
    const getEntityIndex = vi
      .fn<SentinelApi['getEntityIndex']>()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(INDEX)
    const { user } = setup({ api: createTestApi({ getEntityIndex }) })
    await open(user)
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    await screen.findByRole('option', { name: /^edge-gw-02/ })
    expect(getEntityIndex).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Entity search unavailable')).not.toBeInTheDocument()
  })

  it('offers retry as an action too, since the banner button is pointer-only', async () => {
    const getEntityIndex = vi
      .fn<SentinelApi['getEntityIndex']>()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(INDEX)
    const { user } = setup({ api: createTestApi({ getEntityIndex }) })
    const dialog = await open(user)
    await within(dialog).findByText('Entity search unavailable')
    await user.type(combobox(), '>retry')
    expect(options()[0]).toHaveAccessibleName(/^Retry entity search/)
    await user.keyboard('{Enter}')
    expect(dialog).toBeVisible()
    expect(getEntityIndex).toHaveBeenCalledTimes(2)
    await user.clear(combobox())
    await within(dialog).findByRole('group', { name: 'Problems' })
    expect(screen.queryByRole('option', { name: /^Retry entity search/ })).not.toBeInTheDocument()
  })

  it('does not claim "no match" for entities while the index is unavailable', async () => {
    const api = createTestApi({ getEntityIndex: vi.fn().mockRejectedValue(new Error('503')) })
    const { user } = setup({ api })
    const dialog = await open(user)
    await within(dialog).findByText('Entity search unavailable')
    await user.type(combobox(), '@edge')
    expect(screen.queryByText(/^No match/)).not.toBeInTheDocument()
    expect(screen.getByText('Entity search unavailable')).toBeInTheDocument()
  })

  it('keeps the previous entities when a background refresh fails', async () => {
    const getEntityIndex = vi
      .fn<SentinelApi['getEntityIndex']>()
      .mockResolvedValueOnce(INDEX)
      .mockRejectedValue(new Error('503'))
    const { user } = setup({ api: createTestApi({ getEntityIndex }) })
    await openLoaded(user)
    await user.keyboard('{Escape}')
    await open(user)
    await waitFor(() => expect(getEntityIndex).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('option', { name: /^edge-gw-02/ })).toBeInTheDocument()
    expect(screen.queryByText('Entity search unavailable')).not.toBeInTheDocument()
  })
})
