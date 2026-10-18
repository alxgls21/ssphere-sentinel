import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy, type ComponentType } from 'react'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registryOverrides } from '@/config/testing'
import { keyInit } from '@/app/hotkeys/testing'
import { AppShell } from './AppShell'
import { DESKTOP, LAPTOP, PHONE, TABLET, renderShell, stubViewport } from './testing'

const overrides = registryOverrides()

// The palette is another module's; the shell only has to mount it.
vi.mock('./command-palette', async () => {
  const { useShell } = await import('@/app/shell')
  return {
    CommandPalette: () => {
      const { paletteOpen } = useShell()
      return <div data-testid="palette" data-open={paletteOpen} />
    },
  }
})

const NeverLoads = lazy(() => new Promise<{ default: ComponentType }>(() => {}))

function Boom(): never {
  throw new Error('chart exploded')
}

function renderApp(route = '/', width = DESKTOP) {
  const viewport = stubViewport(width)
  const view = renderShell(
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<p>overview page</p>} />
        <Route path="servers" element={<p>servers page</p>} />
        <Route path="docker" element={<p>docker page</p>} />
        <Route path="alerts" element={<p>alerts page</p>} />
        <Route path="customers" element={<p>customers placeholder</p>} />
        <Route path="settings/*" element={<p>settings page</p>} />
        <Route path="loading" element={<NeverLoads />} />
        <Route path="boom" element={<Boom />} />
      </Route>
    </Routes>,
    { route },
  )
  return { ...view, ...viewport, user: userEvent.setup() }
}

afterEach(() => {
  overrides.restore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.title = ''
})

describe('AppShell: landmarks and skip links', () => {
  it('has a banner, a navigation, a main that can take focus, and a contentinfo', () => {
    renderApp()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveTextContent('overview page')
  })

  it('makes the first two tab stops Skip to main content and Skip to Needs attention', async () => {
    const { user } = renderApp()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Skip to Needs attention' })).toHaveFocus()
  })

  it('hides the skip links until they have focus', () => {
    renderApp()
    for (const name of ['Skip to main content', 'Skip to Needs attention']) {
      const link = screen.getByRole('link', { name })
      expect(link).toHaveClass('sr-only', 'focus:not-sr-only')
    }
  })

  it('moves focus to main when Skip to main content is followed', async () => {
    const { user } = renderApp()
    await user.click(screen.getByRole('link', { name: 'Skip to main content' }))
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('moves focus to the first panel when Skip to Needs attention is followed', async () => {
    const { user } = renderApp()
    const panel = document.createElement('section')
    panel.tabIndex = -1
    panel.dataset.panel = '1'
    screen.getByRole('main').append(panel)
    await user.click(screen.getByRole('link', { name: 'Skip to Needs attention' }))
    expect(panel).toHaveFocus()
  })

  it('falls back to main while that panel has not rendered yet', async () => {
    const { user } = renderApp()
    await user.click(screen.getByRole('link', { name: 'Skip to Needs attention' }))
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('offers Skip to Needs attention only where there is a Needs attention panel', () => {
    renderApp('/servers')
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Skip to Needs attention' })).not.toBeInTheDocument()
  })

  it('lets the content fill the width: main has no max width', () => {
    renderApp()
    expect(screen.getByRole('main').className).not.toMatch(/max-w/)
    expect(screen.getByRole('main')).toHaveClass('p-3', 'overflow-auto')
  })
})

describe('AppShell: responsive layout', () => {
  it.each(
    [DESKTOP, LAPTOP, TABLET, PHONE].flatMap((width) =>
      ['notifications', 'alert-rules', 'alert-rules/new', 'system'].map((section) => ({
        width,
        section,
      })),
    ),
  )('hides monitoring filters on Settings/$section at $width px', async ({ width, section }) => {
    renderApp(`/settings/${section}?customer=acme&site=athens&range=6h`, width)
    await act(async () => {})
    const banner = within(screen.getByRole('banner'))
    expect(banner.queryByRole('combobox', { name: 'Customer' })).not.toBeInTheDocument()
    expect(banner.queryByRole('combobox', { name: 'Site' })).not.toBeInTheDocument()
    expect(banner.queryByRole('radiogroup', { name: 'Time range' })).not.toBeInTheDocument()
    expect(banner.queryByRole('button', { name: /Filters/ })).not.toBeInTheDocument()
    expect(banner.queryByText('acme')).not.toBeInTheDocument()
    expect(banner.queryByText('athens-dc')).not.toBeInTheDocument()
  })

  it('at 1600px shows the expanded sidebar, the full topbar and the status bar', async () => {
    renderApp('/', DESKTOP)
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Time range' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument()
  })

  it('at 1100px shows the 56px rail and folds scope and range into Filters', () => {
    renderApp('/', LAPTOP)
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Time range' })).not.toBeInTheDocument()
  })

  it('at 900px keeps the topbar but moves the sidebar into a drawer behind a menu button', () => {
    renderApp('/', TABLET)
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toHaveTextContent('overview')
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })

  it('on a phone swaps the topbar for the 48px app bar and drops the status bar', () => {
    renderApp('/', PHONE)
    const bar = screen.getByRole('banner')
    expect(bar).toHaveClass('h-12')
    expect(within(bar).getByText('SENTINEL')).toBeInTheDocument()
    // The compact chip is the word "Mock" in the DOM; the tag style uppercases it.
    expect(within(bar).getByText('Demo')).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: 'Open navigation' })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: 'Search or run a command' })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(bar.querySelector('[data-state]')).not.toBeNull()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Time range' })).not.toBeInTheDocument()
  })

  it('opens the palette from the phone’s search button', async () => {
    const { user } = renderApp('/', PHONE)
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'false')
    await user.click(screen.getByRole('button', { name: 'Search or run a command' }))
    expect(screen.getByTestId('palette')).toHaveAttribute('data-open', 'true')
  })

  it('mounts the command palette', () => {
    renderApp()
    expect(screen.getByTestId('palette')).toBeInTheDocument()
  })
})

describe('AppShell: navigation drawer', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Navigation' })

  it('opens from the menu button as a modal dialog holding the navigation', async () => {
    const { user } = renderApp('/', TABLET)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    expect(dialog().tagName).toBe('DIALOG')
    expect(dialog()).toHaveAttribute('open')
    expect(within(dialog()).getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(within(dialog()).getAllByRole('link')).toHaveLength(9)
  })

  it('closes on Escape and returns focus to the menu button', async () => {
    const { user } = renderApp('/', TABLET)
    const menu = screen.getByRole('button', { name: 'Open navigation' })
    await user.click(menu)
    fireEvent.keyDown(within(dialog()).getByRole('link', { name: 'Overview' }), keyInit('escape'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(menu).toHaveFocus()
  })

  it('closes when the scrim is clicked', async () => {
    const { user } = renderApp('/', TABLET)
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(dialog())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes from its own Close navigation button', async () => {
    const { user } = renderApp('/', TABLET)
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Close navigation' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes when a link is followed, and focus lands on the new screen, not the menu button', async () => {
    const { user } = renderApp('/', TABLET)
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await user.click(within(dialog()).getByRole('link', { name: 'Servers' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveTextContent('servers page')
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('is closed for good when the window grows past 1024px', async () => {
    const { user, resize } = renderApp('/', TABLET)
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    act(() => resize(DESKTOP))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    act(() => resize(TABLET))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens from [ on a tablet, where there is no rail to collapse', () => {
    renderApp('/', TABLET)
    fireEvent.keyDown(document.body, { key: '[', code: 'BracketLeft' })
    expect(dialog()).toHaveAttribute('open')
  })
})

describe('AppShell: moving between screens', () => {
  it('moves focus to main on a route change, and back to the top', async () => {
    const { user } = renderApp('/')
    const main = screen.getByRole('main')
    expect(main).not.toHaveFocus()
    main.scrollTop = 120
    await user.click(screen.getByRole('link', { name: 'Servers' }))
    expect(main).toHaveTextContent('servers page')
    expect(main).toHaveFocus()
    expect(main.scrollTop).toBe(0)
  })

  it('does that for a go-to chord too', () => {
    renderApp('/')
    fireEvent.keyDown(document.body, keyInit('g'))
    fireEvent.keyDown(document.body, keyInit('d'))
    expect(screen.getByRole('main')).toHaveTextContent('docker page')
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('leaves focus alone when only the view (scope, range) changes', async () => {
    const { user } = renderApp('/')
    const radio = screen.getByRole('radio', { name: '6h' })
    await user.click(radio)
    expect(radio).toHaveFocus()
  })

  it('titles the tab with the screen', async () => {
    renderApp('/servers')
    await waitFor(() => expect(document.title).toBe('[MOCK] ● 30 OK - Servers - Sentinel'))
  })

  it('toggles the sidebar with [', () => {
    renderApp('/')
    fireEvent.keyDown(document.body, { key: '[', code: 'BracketLeft' })
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('opens the shortcut sheet with ? and closes it with Escape', () => {
    renderApp('/')
    fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    fireEvent.keyDown(document.body, keyInit('escape'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('AppShell: a screen that is slow or broken', () => {
  it('shows a loading state inside main while a screen loads, with the shell already painted', () => {
    renderApp('/loading')
    expect(within(screen.getByRole('main')).getByText('Loading screen')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
  })

  it('contains a screen that throws: an error with Retry, the sidebar still usable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { user } = renderApp('/boom')
    const alert = within(screen.getByRole('main')).getByRole('alert')
    expect(alert).toHaveTextContent('This screen could not be loaded')
    expect(alert).toHaveTextContent('chart exploded')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Servers' }))
    expect(screen.getByRole('main')).toHaveTextContent('servers page')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('AppShell: demo data', () => {
  it('says DEMO DATA above a screen that shows the sample fleet', () => {
    renderApp('/servers')
    const note = screen.getByRole('complementary', { name: 'Demo data' })
    expect(note).toHaveTextContent('DEMO DATA')
    expect(note).toHaveTextContent('not your infrastructure')
  })

  it('says it above the Alerts screen too: its list is the sample fleet’s, which is empty', () => {
    renderApp('/alerts')
    expect(screen.getByRole('complementary', { name: 'Demo data' })).toBeInTheDocument()
  })

  it('says it on the Overview too', () => {
    renderApp('/')
    expect(screen.getByRole('complementary', { name: 'Demo data' })).toBeInTheDocument()
  })

  it('does not say it on a screen that has no data yet: it only shows its placeholder', () => {
    renderApp('/customers')
    expect(screen.queryByRole('complementary', { name: 'Demo data' })).toBeNull()
  })

  it('still says it over an HTTP adapter while a feature that shows figures is not connected', () => {
    overrides.set('servers', { connected: false })
    stubViewport(DESKTOP)
    renderShell(
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<p>overview page</p>} />
        </Route>
      </Routes>,
      { api: { source: 'http' } },
    )
    expect(screen.getByRole('complementary', { name: 'Demo data' })).toBeInTheDocument()
  })

  it('does not say it when every feature is connected and the data is real', () => {
    overrides.connectAll()
    stubViewport(DESKTOP)
    renderShell(
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<p>overview page</p>} />
        </Route>
      </Routes>,
      { api: { source: 'http' } },
    )
    expect(screen.queryByRole('complementary', { name: 'Demo data' })).toBeNull()
  })
})
