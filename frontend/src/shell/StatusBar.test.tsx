import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HotkeyContext, type HotkeyState } from '@/app/hotkeys/mode'
import { LiveContext, LiveStore, type LiveControls } from '@/app/live'
import { useShell } from '@/app/shell'
import { registryOverrides } from '@/config/testing'
import { STATUS_TEXT } from '@/ui/status'
import { FlashStrip, StatusBar } from './StatusBar'
import { renderShell } from './testing'

const T0 = Date.UTC(2026, 0, 1, 14, 5, 0)

const overrides = registryOverrides()

afterEach(() => {
  overrides.restore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function Flasher() {
  const { flashStatus } = useShell()
  return (
    <button type="button" onClick={() => flashStatus('Acknowledge: not implemented in backend')}>
      flash
    </button>
  )
}

interface SetupOptions {
  hotkeys?: HotkeyState
  paused?: boolean
  /** Last successful load as seconds before "now"; null for none yet. */
  updatedAgo?: number | null
  fetching?: boolean
  renderOptions?: Parameters<typeof renderShell>[1]
  ui?: 'bar' | 'strip'
}

function setup({
  hotkeys = { mode: 'normal', pending: null },
  paused = false,
  updatedAgo = 3,
  fetching = false,
  renderOptions,
  ui = 'bar',
}: SetupOptions = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  const store = new LiveStore()
  const controls: LiveControls = {
    pollMs: 15_000,
    paused,
    togglePause: () => {},
    refreshToken: 0,
    refresh: () => {},
    store,
  }
  store.report('panel', {
    updatedAt: updatedAgo === null ? null : T0 - updatedAgo * 1000,
    failed: false,
    fetching,
  })
  renderShell(
    <LiveContext.Provider value={controls}>
      <HotkeyContext.Provider value={hotkeys}>
        {ui === 'bar' ? (
          <StatusBar />
        ) : (
          <div data-testid="strip">
            <FlashStrip />
          </div>
        )}
        <Flasher />
      </HotkeyContext.Provider>
    </LiveContext.Provider>,
    renderOptions,
  )
}

const bar = () => screen.getByRole('contentinfo')

describe('StatusBar: landmark and source', () => {
  it('is the contentinfo landmark and shows the version', () => {
    setup()
    expect(within(bar()).getByText('v0.1.0')).toBeInTheDocument()
  })

  it('names the mock data source and the current scenario', () => {
    setup()
    expect(bar()).toHaveTextContent(
      'MOCK · mock://fixtures v1 · MockApi (no backend read APIs) · scenario normal',
    )
  })

  it('follows the mock scenario in the URL', () => {
    setup({ renderOptions: { route: '/?mock=stale' } })
    expect(bar()).toHaveTextContent('scenario stale')
  })

  it('always carries a DEMO DATA block while the data is sample data, and not for real data', () => {
    setup()
    expect(within(bar()).getByText('DEMO DATA')).toBeInTheDocument()
  })

  it('does not say LIVE over an HTTP adapter while features are not connected', () => {
    setup({ renderOptions: { api: { source: 'http' } } })
    expect(bar()).toHaveTextContent('Partly demo data')
    expect(bar()).not.toHaveTextContent('LIVE')
    expect(within(bar()).getByText('DEMO DATA')).toBeInTheDocument()
  })

  it('says LIVE with the API address when every feature is connected and real', () => {
    overrides.connectAll()
    setup({ renderOptions: { api: { source: 'http' } } })
    expect(bar()).toHaveTextContent(/LIVE · https?:\/\/.+\/api\/v1/)
    expect(bar()).not.toHaveTextContent('MOCK')
    expect(within(bar()).queryByText('DEMO DATA')).toBeNull()
  })
})

describe('StatusBar: mode block', () => {
  const mode = () => bar().querySelector('[aria-hidden="true"]') as HTMLElement
  const spoken = () => within(bar()).getAllByRole('status')[0] as HTMLElement

  it('shows NORMAL on the primary fill, silently', () => {
    setup()
    expect(mode()).toHaveTextContent('NORMAL')
    expect(mode()).toHaveClass('bg-primary', 'text-bg')
    expect(spoken()).toBeEmptyDOMElement()
  })

  it('shows INSERT while a text field has focus, and says shortcuts are suspended', () => {
    setup({ hotkeys: { mode: 'insert', pending: null } })
    expect(mode()).toHaveTextContent('INSERT')
    expect(spoken()).toHaveTextContent('Shortcuts suspended while typing')
  })

  it('shows the pending chord as g…', () => {
    setup({ hotkeys: { mode: 'pending', pending: 'g' } })
    expect(mode()).toHaveTextContent('g…')
    expect(spoken()).toHaveTextContent('g pressed, waiting for the next key')
  })

  it('shows KEYS OFF, not NORMAL, when single-key shortcuts are off', () => {
    setup({ hotkeys: { mode: 'off', pending: null } })
    expect(mode()).toHaveTextContent('KEYS OFF')
    expect(mode()).not.toHaveClass('bg-primary')
    expect(spoken()).toHaveTextContent('Single-key shortcuts are off')
  })

  it('hides the mode block itself from assistive technology', () => {
    setup()
    expect(mode()).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('StatusBar: next poll', () => {
  it('counts down to the next poll', () => {
    setup({ updatedAgo: 3 })
    expect(bar()).toHaveTextContent('next poll 12s')
    act(() => vi.advanceTimersByTime(5000))
    expect(bar()).toHaveTextContent('next poll 7s')
  })

  it('says PAUSED while frozen, updating while fetching, and a dash before the first load', () => {
    setup({ paused: true })
    expect(bar()).toHaveTextContent('PAUSED')
  })

  it('says updating while a request is in flight', () => {
    setup({ fetching: true })
    expect(bar()).toHaveTextContent('updating')
  })

  it('has no countdown before anything has loaded', () => {
    setup({ updatedAgo: null })
    expect(bar()).toHaveTextContent('next poll —')
  })
})

describe('StatusBar: hints and transient messages', () => {
  it('shows the context key hints', () => {
    setup()
    expect(bar()).toHaveTextContent('p pause · r refresh · ? keys')
  })

  it('replaces the hints with a flashed message for 4 seconds, in a status region', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'flash' }))
    const message = within(bar()).getByText('Acknowledge: not implemented in backend')
    expect(message.tagName).toBe('OUTPUT')
    expect(bar()).not.toHaveTextContent('p pause')
    act(() => vi.advanceTimersByTime(4001))
    expect(bar()).toHaveTextContent('p pause · r refresh · ? keys')
    expect(bar()).not.toHaveTextContent('Acknowledge')
  })
})

describe('StatusBar: offline', () => {
  it('adds a critical OFFLINE segment when the browser is offline, and removes it on reconnect', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    setup()
    expect(within(bar()).queryByText('OFFLINE')).not.toBeInTheDocument()

    online.mockReturnValue(false)
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    const segment = within(bar()).getByText('OFFLINE')
    expect(segment.closest('[data-status="critical"]')).not.toBeNull()
    expect(segment.closest('[data-status]')).toHaveClass(STATUS_TEXT.critical)

    online.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(within(bar()).queryByText('OFFLINE')).not.toBeInTheDocument()
  })
})

describe('FlashStrip (phones have no status bar)', () => {
  it('is invisible until a message is flashed, then shows it for 4 seconds', () => {
    setup({ ui: 'strip' })
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    const region = within(screen.getByTestId('strip')).getByRole('status')
    expect(region).toHaveClass('sr-only')
    fireEvent.click(screen.getByRole('button', { name: 'flash' }))
    expect(region).toHaveTextContent('Acknowledge: not implemented in backend')
    expect(region).not.toHaveClass('sr-only')
    act(() => vi.advanceTimersByTime(4001))
    expect(region).toHaveClass('sr-only')
  })
})
