import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useShell } from '@/app/shell'
import { useFlashMessage } from './flash'
import { DESKTOP, LAPTOP, renderShell, stubViewport } from './testing'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Probe() {
  const shell = useShell()
  const flash = useFlashMessage()
  return (
    <>
      <output aria-label="state">
        {JSON.stringify({
          collapsed: shell.sidebarCollapsed,
          nav: shell.mobileNavOpen,
          palette: shell.paletteOpen,
          sheet: shell.shortcutsOpen,
          flash,
        })}
      </output>
      <button onClick={shell.toggleSidebar}>toggle</button>
      <button onClick={shell.openPalette}>open palette</button>
      <button onClick={shell.openShortcuts}>open sheet</button>
      <button onClick={() => shell.setMobileNavOpen(true)}>open nav</button>
      <button onClick={() => shell.setMobileNavOpen(false)}>close nav</button>
      <button onClick={shell.closePalette}>close palette</button>
      <button onClick={() => shell.announce('first')}>say first</button>
      <button onClick={() => shell.announce('second')}>say second</button>
      <button onClick={() => shell.announce('third')}>say third</button>
      <button onClick={() => shell.flashStatus('Not implemented in backend')}>flash</button>
      <button onClick={() => shell.flashStatus('Another message')}>flash again</button>
    </>
  )
}

const state = () => JSON.parse(screen.getByLabelText('state').textContent ?? '{}')
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const announcer = () => screen.getByRole('status', { name: 'Announcements' })

describe('sidebar', () => {
  it('opens as the rail below 1440px and expanded from 1440px up', () => {
    stubViewport(LAPTOP)
    const { unmount } = renderShell(<Probe />)
    expect(state().collapsed).toBe(true)
    unmount()
    stubViewport(DESKTOP)
    renderShell(<Probe />)
    expect(state().collapsed).toBe(false)
  })

  it('remembers the operator’s choice over the viewport default', () => {
    stubViewport(DESKTOP)
    const first = renderShell(<Probe />)
    click('toggle')
    expect(state().collapsed).toBe(true)
    expect(window.localStorage.getItem('sentinel.sidebar.v1')).toBe('collapsed')
    first.unmount()

    renderShell(<Probe />)
    expect(state().collapsed).toBe(true)
    click('toggle')
    expect(window.localStorage.getItem('sentinel.sidebar.v1')).toBe('expanded')
  })

  it('does not write anything until the operator chooses', () => {
    renderShell(<Probe />)
    expect(window.localStorage.getItem('sentinel.sidebar.v1')).toBeNull()
  })

  it('works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderShell(<Probe />)
    click('toggle')
    expect(state().collapsed).toBe(true)
    vi.restoreAllMocks()
  })
})

describe('overlays', () => {
  it('keeps one open at a time', () => {
    renderShell(<Probe />)
    click('open palette')
    expect(state()).toMatchObject({ palette: true, sheet: false, nav: false })
    click('open sheet')
    expect(state()).toMatchObject({ palette: false, sheet: true, nav: false })
    click('open nav')
    expect(state()).toMatchObject({ palette: false, sheet: false, nav: true })
  })

  it('closes only the overlay it is asked to close', () => {
    renderShell(<Probe />)
    click('open sheet')
    click('close palette')
    click('close nav')
    expect(state().sheet).toBe(true)
  })
})

describe('announce', () => {
  /** Speech starts a beat after the region is cleared, so a repeated message is a visible change. */
  const settle = () => act(() => vi.advanceTimersByTime(100))

  it('speaks the first message through one polite region', () => {
    vi.useFakeTimers()
    renderShell(<Probe />)
    expect(announcer()).toBeEmptyDOMElement()
    click('say first')
    settle()
    expect(announcer()).toHaveTextContent('first')
    expect(announcer()).toHaveAttribute('aria-atomic', 'true')
  })

  it('speaks at most once per 5 seconds, and only the newest waiting message', () => {
    vi.useFakeTimers()
    renderShell(<Probe />)
    click('say first')
    settle()
    act(() => vi.advanceTimersByTime(900))
    click('say second')
    click('say third')
    expect(announcer()).toHaveTextContent('first')
    act(() => vi.advanceTimersByTime(3900))
    expect(announcer()).toHaveTextContent('first')
    act(() => vi.advanceTimersByTime(200))
    settle()
    expect(announcer()).toHaveTextContent('third')
  })

  it('speaks again once the window has passed', () => {
    vi.useFakeTimers()
    renderShell(<Probe />)
    click('say first')
    act(() => vi.advanceTimersByTime(5000))
    click('say second')
    settle()
    expect(announcer()).toHaveTextContent('second')
  })

  it('lets an identical message be heard again: the region is cleared before it is set', () => {
    vi.useFakeTimers()
    renderShell(<Probe />)
    click('say first')
    settle()
    expect(announcer()).toHaveTextContent('first')
    act(() => vi.advanceTimersByTime(5000))
    click('say first')
    // Without the clear, React would bail out on identical text and a screen reader would stay silent.
    expect(announcer()).toBeEmptyDOMElement()
    settle()
    expect(announcer()).toHaveTextContent('first')
  })
})

describe('flashStatus', () => {
  it('shows a message for 4 seconds', () => {
    vi.useFakeTimers()
    renderShell(<Probe />)
    click('flash')
    expect(state().flash).toBe('Not implemented in backend')
    act(() => vi.advanceTimersByTime(3999))
    expect(state().flash).toBe('Not implemented in backend')
    act(() => vi.advanceTimersByTime(2))
    expect(state().flash).toBeNull()
  })

  it('restarts the 4 seconds for a newer message', () => {
    vi.useFakeTimers()
    renderShell(<Probe />)
    click('flash')
    act(() => vi.advanceTimersByTime(3000))
    click('flash again')
    act(() => vi.advanceTimersByTime(3000))
    expect(state().flash).toBe('Another message')
    act(() => vi.advanceTimersByTime(1001))
    expect(state().flash).toBeNull()
  })
})
