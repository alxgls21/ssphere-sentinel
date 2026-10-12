import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEXT_PROBLEM_EVENT, type NextProblemDetail } from '@/config/events'
import { PHONE, renderShell, stubViewport } from '@/shell/testing'
import { useLocation } from 'react-router'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { HotkeyProvider } from './HotkeyProvider'
import { useHotkeyState } from './mode'
import { keyInit } from './testing'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Probe() {
  const { pathname, search } = useLocation()
  const live = useLive()
  const shell = useShell()
  const prefs = usePrefs()
  const { mode, pending } = useHotkeyState()
  return (
    <>
      <output aria-label="state">
        {JSON.stringify({
          at: pathname + search,
          paused: live.paused,
          refreshes: live.refreshToken,
          palette: shell.paletteOpen,
          sheet: shell.shortcutsOpen,
          nav: shell.mobileNavOpen,
          collapsed: shell.sidebarCollapsed,
          tz: prefs.tz,
          mode,
          pending,
        })}
      </output>
      <input aria-label="Field" />
      <button type="button" onClick={() => prefs.setSingleKeyShortcuts(false)}>
        keys off
      </button>
      <section data-panel="2" tabIndex={-1} aria-label="Panel two" />
      <details data-testid="folded">
        <summary>Planned</summary>
        <section data-panel="5" tabIndex={-1} aria-label="Panel five" />
      </details>
    </>
  )
}

function setup(route = '/') {
  renderShell(
    <HotkeyProvider>
      <Probe />
    </HotkeyProvider>,
    { route },
  )
  return {
    state: () => JSON.parse(screen.getByLabelText('state').textContent ?? '{}'),
    /** Presses a shortcut; true means the page did not call preventDefault. */
    press: (spec: string, target: Element = document.body) =>
      fireEvent.keyDown(target, keyInit(spec)),
  }
}

describe('HotkeyProvider: actions', () => {
  it('p pauses and resumes, r refreshes, z switches the timezone', () => {
    const { press, state } = setup()
    press('p')
    expect(state().paused).toBe(true)
    press('p')
    expect(state().paused).toBe(false)
    press('r')
    expect(state().refreshes).toBe(1)
    press('z')
    expect(state().tz).toBe('local')
    press('z')
    expect(state().tz).toBe('utc')
  })

  it('g then a screen key goes there and keeps the scope and range of the view', () => {
    const { press, state } = setup('/?range=6h&customer=acme')
    press('g')
    press('s')
    expect(state().at).toBe('/servers?range=6h&customer=acme')
    press('g')
    press('o')
    expect(state().at).toBe('/?range=6h&customer=acme')
  })

  it('t and Shift+T step the time range in the URL', () => {
    const { press, state } = setup('/?range=6h')
    press('t')
    expect(state().at).toBe('/?range=24h')
    press('t')
    expect(state().at).toBe('/?range=15m')
    press('shift+t')
    expect(state().at).toBe('/?range=24h')
    // The default range is not written to the URL.
    press('shift+t')
    press('shift+t')
    press('shift+t')
    press('t')
    expect(state().at).toBe('/')
  })

  it('opens the palette and the sheet, with the punctuation and the chord alternates', () => {
    const { press, state } = setup()
    press('/')
    expect(state().palette).toBe(true)
    press('escape')
    expect(state().palette).toBe(false)
    press('?')
    expect(state().sheet).toBe(true)
    press('escape')
    press('mod+/')
    expect(state().sheet).toBe(true)
    press('escape')
    press('mod+k')
    expect(state().palette).toBe(true)
  })

  it('toggles the sidebar with [ and Ctrl+B', () => {
    const { press, state } = setup()
    expect(state().collapsed).toBe(false)
    press('[')
    expect(state().collapsed).toBe(true)
    press('mod+b')
    expect(state().collapsed).toBe(false)
  })

  it('opens the navigation drawer instead on a phone', () => {
    stubViewport(PHONE)
    const { press, state } = setup()
    press('[')
    expect(state().nav).toBe(true)
    expect(state().collapsed).toBe(true)
  })

  it('focuses the panel with the matching data-panel', () => {
    const { press } = setup()
    press('2')
    expect(screen.getByLabelText('Panel two')).toHaveFocus()
    press('9') // no such panel: nothing happens
    expect(screen.getByLabelText('Panel two')).toHaveFocus()
  })

  it('opens the collapsed section a panel lives in, so its digit key is not a silent no-op', () => {
    const { press } = setup()
    const folded = screen.getByTestId('folded') as HTMLDetailsElement
    expect(folded.open).toBe(false)
    press('5')
    expect(folded.open).toBe(true)
    expect(screen.getByLabelText('Panel five')).toHaveFocus()
  })

  it('sends next and previous problem only from the Overview', () => {
    const heard: number[] = []
    const listen = (event: Event) =>
      heard.push((event as CustomEvent<NextProblemDetail>).detail.direction)
    window.addEventListener(NEXT_PROBLEM_EVENT, listen)
    try {
      const overview = setup('/')
      overview.press('n')
      overview.press('shift+n')
      expect(heard).toEqual([1, -1])
    } finally {
      window.removeEventListener(NEXT_PROBLEM_EVENT, listen)
    }
  })

  it('stays quiet about problems on every other screen', () => {
    const listen = vi.fn()
    window.addEventListener(NEXT_PROBLEM_EVENT, listen)
    try {
      setup('/servers').press('n')
      expect(listen).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(NEXT_PROBLEM_EVENT, listen)
    }
  })
})

describe('HotkeyProvider: when keys must not fire', () => {
  it('ignores single keys typed in a field, shows INSERT, and still opens the palette on Ctrl+K', () => {
    const { press, state } = setup()
    const field = screen.getByLabelText('Field')
    act(() => field.focus())
    expect(state().mode).toBe('insert')
    press('p', field)
    press('/', field)
    expect(state().paused).toBe(false)
    expect(state().palette).toBe(false)
    press('mod+k', field)
    expect(state().palette).toBe(true)
    act(() => field.blur())
  })

  it('returns to NORMAL when focus leaves the field', () => {
    const { state } = setup()
    const field = screen.getByLabelText('Field')
    act(() => field.focus())
    act(() => field.blur())
    expect(state().mode).toBe('normal')
  })

  it('suspends single-key shortcuts when the operator turns them off, but not Ctrl+K or Esc', () => {
    const { press, state } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'keys off' }))
    expect(state().mode).toBe('off')
    press('p')
    press('g')
    press('s')
    expect(state().paused).toBe(false)
    expect(state().at).toBe('/')
    press('mod+k')
    expect(state().palette).toBe(true)
    press('escape')
    expect(state().palette).toBe(false)
  })

  it('lets an open overlay swallow the other keys', () => {
    const { press, state } = setup()
    press('?')
    press('p')
    press('r')
    press('mod+k')
    expect(state()).toMatchObject({ sheet: true, paused: false, refreshes: 0, palette: false })
  })

  it('ignores a key another control already handled, and auto-repeat', () => {
    const { state } = setup()
    const field = document.createElement('div')
    document.body.append(field)
    field.addEventListener('keydown', (event) => event.preventDefault())
    fireEvent.keyDown(field, keyInit('p'))
    expect(state().paused).toBe(false)
    field.remove()

    fireEvent.keyDown(document.body, { ...keyInit('p'), repeat: true })
    expect(state().paused).toBe(false)
  })

  it('does not treat a held modifier on its own as a key', () => {
    const { press, state } = setup()
    press('g')
    fireEvent.keyDown(document.body, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    expect(state().pending).toBe('g')
    press('s')
    expect(state().at).toBe('/servers')
  })

  it('claims the keys it handles from the browser, but not Escape', () => {
    const { press } = setup()
    expect(press('mod+k')).toBe(false)
    press('escape')
    expect(press('/')).toBe(false)
    press('escape')
    expect(press('escape')).toBe(true)
    expect(press('x')).toBe(true)
  })
})

describe('HotkeyProvider: the pending chord', () => {
  it('shows g… in the mode block and clears after 1.2 seconds', () => {
    vi.useFakeTimers()
    const { press, state } = setup()
    press('g')
    expect(state()).toMatchObject({ mode: 'pending', pending: 'g' })
    act(() => vi.advanceTimersByTime(1199))
    expect(state().mode).toBe('pending')
    act(() => vi.advanceTimersByTime(2))
    expect(state()).toMatchObject({ mode: 'normal', pending: null })
    // Too late: the second key is now a plain "s", which is not bound.
    press('s')
    expect(state().at).toBe('/')
  })

  it('cancels on Escape without closing anything, and on an unrelated key', () => {
    const { press, state } = setup()
    press('g')
    press('escape')
    expect(state().mode).toBe('normal')
    press('g')
    press('x')
    expect(state().mode).toBe('normal')
    expect(state().at).toBe('/')
  })

  it('lets the cancelling key keep its meaning for the browser', () => {
    const { press } = setup()
    press('g')
    expect(press('x')).toBe(true)
  })
})
