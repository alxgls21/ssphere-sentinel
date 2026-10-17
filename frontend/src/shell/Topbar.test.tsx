import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { registryOverrides } from '@/config/testing'
import { stubFocusVisible } from '@/ui/controls/testing'
import { Topbar } from './Topbar'
import { renderShell } from './testing'

const overrides = registryOverrides()

afterEach(() => {
  overrides.restore()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Probe() {
  const { pathname, search } = useLocation()
  const shell = useShell()
  const { tz, singleKeyShortcuts } = usePrefs()
  return (
    <output aria-label="state">
      {JSON.stringify({
        at: pathname + search,
        palette: shell.paletteOpen,
        sheet: shell.shortcutsOpen,
        nav: shell.mobileNavOpen,
        tz,
        singleKeyShortcuts,
      })}
    </output>
  )
}

const state = () => JSON.parse(screen.getByLabelText('state').textContent ?? '{}')

async function setup(
  props: Partial<Parameters<typeof Topbar>[0]> = {},
  options: Parameters<typeof renderShell>[1] = {},
) {
  const view = renderShell(
    <>
      <Topbar title="Overview" compact={false} drawer={false} {...props} />
      <Probe />
    </>,
    options,
  )
  // The customers and sites arrive after the first render.
  await act(async () => {})
  return { user: userEvent.setup(), ...view }
}

describe('Topbar: landmark and breadcrumb', () => {
  it('is the banner landmark, with the location as a prompt ending in the live cursor', async () => {
    await setup()
    const banner = screen.getByRole('banner')
    const location = within(banner).getByRole('list', { name: 'Location' })
    expect(
      within(location)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['sentinel', 'overview'])
    expect(within(location).getByText('overview')).toHaveAttribute('aria-current', 'page')
    expect(banner.querySelector('[data-state="fetching"], [data-state="live"]')).not.toBeNull()
  })

  it('writes the last segment in the text color and the earlier ones in faint', async () => {
    await setup()
    expect(screen.getByText('overview')).toHaveClass('text-fg')
    expect(screen.getByText('sentinel')).toHaveClass('text-fg-faint')
  })

  it('names the scope in the path: sentinel › acme › athens-dc › overview', async () => {
    await setup({}, { route: '/?customer=acme&site=athens' })
    await screen.findByText('athens-dc')
    const names = within(screen.getByRole('list', { name: 'Location' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
      .filter(Boolean)
    expect(names).toEqual(['sentinel', 'acme', 'athens-dc', 'overview'])
  })

  it('shortens to the screen title alone when compact', async () => {
    await setup({ compact: true })
    const names = within(screen.getByRole('list', { name: 'Location' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(names).toEqual(['overview'])
  })
})

describe('Topbar: scope', () => {
  it('has a customer picker then a site picker, both native selects', async () => {
    await setup()
    const customer = screen.getByRole('combobox', { name: 'Customer' })
    const site = screen.getByRole('combobox', { name: 'Site' })
    expect(customer.tagName).toBe('SELECT')
    expect(site.tagName).toBe('SELECT')
    expect(customer.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      within(customer)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All customers', 'Acme', 'Globex'])
  })

  it('puts the chosen scope in the URL and narrows the sites to the customer', async () => {
    const { user } = await setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Customer' }), 'Acme')
    expect(state().at).toBe('/?customer=acme')
    const site = screen.getByRole('combobox', { name: 'Site' })
    expect(
      within(site)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All sites', 'Athens DC', 'Patras'])
    await user.selectOptions(site, 'Athens DC')
    expect(state().at).toBe('/?customer=acme&site=athens')
  })

  it('drops the site when another customer is chosen, and everything for all customers', async () => {
    const { user } = await setup({}, { route: '/?customer=acme&site=athens' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Customer' }), 'Globex')
    expect(state().at).toBe('/?customer=globex')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Customer' }), 'All customers')
    expect(state().at).toBe('/')
  })

  it('chooses a site’s customer with it', async () => {
    const { user } = await setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Site' }), 'Globex / Thess-1')
    expect(state().at).toBe('/?customer=globex&site=thess')
  })

  it('keeps the pickers inert until the options arrive', async () => {
    await setup({}, { api: { getScopeOptions: () => new Promise(() => {}) } })
    expect(screen.getByRole('combobox', { name: 'Customer' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Site' })).toBeDisabled()
  })
})

describe('Topbar: time range', () => {
  it('is a radiogroup of 15m 1h 6h 24h with 1h selected by default', async () => {
    await setup()
    const group = screen.getByRole('radiogroup', { name: 'Time range' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['15m', '1h', '6h', '24h'])
    expect(within(group).getByRole('radio', { name: '1h' })).toBeChecked()
  })

  it('puts the choice in the URL', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('radio', { name: '6h' }))
    expect(state().at).toBe('/?range=6h')
    expect(screen.getByRole('radio', { name: '6h' })).toBeChecked()
  })

  it('says in its tooltip that it scopes range panels only', async () => {
    stubFocusVisible()
    await setup()
    screen.getByRole('radio', { name: '6h' }).focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Scopes range panels only')
  })
})

describe('Topbar: clock', () => {
  it('shows HH:mm:ssZ in UTC, hidden from assistive technology, with the minute spoken', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(Date.UTC(2026, 0, 1, 14, 5, 12))
    await setup()
    const clock = screen.getByRole('button', { name: /14:05 UTC/ })
    expect(within(clock).getByText('14:05:12Z')).toHaveAttribute('aria-hidden', 'true')
    expect(clock).toHaveAccessibleName('14:05 UTC, switch to local time')
  })

  it('ticks every second but renames itself only once a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(Date.UTC(2026, 0, 1, 14, 5, 12))
    await setup()
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText('14:05:15Z')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /14:05 UTC/ })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(50_000))
    expect(screen.getByRole('button', { name: /14:06 UTC/ })).toBeInTheDocument()
  })

  it('switches between UTC and local on click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(Date.UTC(2026, 0, 1, 14, 5, 12))
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: /UTC/ }))
    expect(state().tz).toBe('local')
    expect(screen.getByRole('button', { name: /local time, switch to UTC/ })).toBeInTheDocument()
    expect(screen.queryByText(/\d\dZ$/)).not.toBeInTheDocument()
  })
})

describe('Topbar: provenance and the palette', () => {
  it('shows the DEMO DATA chip while the data is mock, and over an HTTP adapter that is not fully connected', async () => {
    const { unmount } = await setup()
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    unmount()
    overrides.set('servers', { connected: false })
    await setup({}, { api: { source: 'http' } })
    expect(screen.getByText('Demo data')).toBeInTheDocument()
  })

  it('has no chip over an HTTP adapter while every feature that shows figures is connected', async () => {
    await setup({}, { api: { source: 'http' } })
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
  })

  it('drops the chip only when every feature is connected and the data is real', async () => {
    overrides.connectAll()
    await setup({}, { api: { source: 'http' } })
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
  })

  it('opens the command palette from the trigger, which shows the platform key', async () => {
    const { user } = await setup()
    const trigger = screen.getByRole('button', { name: 'Search or run a command' })
    expect(trigger).toHaveTextContent('search or run…')
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    expect(within(trigger).getByText('Ctrl')).toBeInTheDocument()
    await user.click(trigger)
    expect(state().palette).toBe(true)
  })

  it('shows Command on macOS', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', userAgentData: undefined })
    await setup()
    const trigger = screen.getByRole('button', { name: 'Search or run a command' })
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Meta+K')
    expect(within(trigger).getByText('Command')).toBeInTheDocument()
  })
})

describe('Topbar: Display menu', () => {
  it('has the preferences, and applies them through usePrefs', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Display options' }))
    const menu = screen.getByRole('menu', { name: 'Display options' })
    const single = within(menu).getByRole('menuitemcheckbox', { name: 'Single-key shortcuts' })
    expect(single).toHaveAttribute('aria-checked', 'true')

    await user.click(single)
    expect(state().singleKeyShortcuts).toBe(false)
    expect(single).toHaveAttribute('aria-checked', 'false')

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Local' }))
    expect(state().tz).toBe('local')
    await user.click(within(menu).getByRole('menuitemradio', { name: 'UTC' }))
    expect(state().tz).toBe('utc')

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Reduce motion' }))
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce')
  })

  it('opens the shortcut sheet from the menu', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('button', { name: 'Display options' }))
    await user.click(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ }))
    expect(state().sheet).toBe(true)
  })
})

describe('Topbar: compact (below 1280px)', () => {
  it('folds scope and range into one Filters menu', async () => {
    await setup({ compact: true })
    expect(screen.queryByRole('combobox', { name: 'Customer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Time range' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
  })

  it('applies a choice from the menu, keeps the menu open, and shows how many filters are active', async () => {
    const { user } = await setup({ compact: true })
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    const menu = screen.getByRole('menu', { name: 'Filters' })

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Acme' }))
    expect(state().at).toBe('/?customer=acme')
    await user.click(within(menu).getByRole('menuitemradio', { name: '6h' }))
    expect(state().at).toBe('/?customer=acme&range=6h')
    expect(screen.getByRole('menu', { name: /Filters/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toHaveTextContent('2')
  })

  it('offers the sites of the chosen customer', async () => {
    const { user } = await setup({ compact: true }, { route: '/?customer=globex' })
    await screen.findByRole('button', { name: 'Filters, 1 active' })
    await user.click(screen.getByRole('button', { name: /Filters/ }))
    const site = screen.getByRole('group', { name: 'Site' })
    expect(
      within(site)
        .getAllByRole('menuitemradio')
        .map((r) => r.textContent),
    ).toEqual(['All sites', 'Thess-1'])
  })
})

describe('Topbar: drawer mode', () => {
  it('carries the button that opens the navigation drawer', async () => {
    const { user } = await setup({ drawer: true })
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    expect(state().nav).toBe(true)
  })

  it('has no such button when the sidebar is on screen', async () => {
    await setup()
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument()
  })
})
