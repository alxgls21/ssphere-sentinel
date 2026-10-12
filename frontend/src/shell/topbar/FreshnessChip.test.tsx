import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveContext, LiveStore, type LiveControls } from '@/app/live'
import { renderApp } from '@/test/render'
import { STATUS_TEXT, STATUS_TINT } from '@/ui/status'
import { FreshnessChip, FreshnessCursor } from './FreshnessChip'
import { LiveCursor } from './LiveCursor'

const T0 = Date.UTC(2026, 0, 1, 14, 5, 0)

afterEach(() => vi.useRealTimers())

/** Renders under a live layer whose freshness the test controls directly. */
function setup(ui = <FreshnessChip />, { paused = false }: { paused?: boolean } = {}) {
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
  renderApp(<LiveContext.Provider value={controls}>{ui}</LiveContext.Provider>)
  return {
    store,
    report: (updatedAt: number | null, extra: { failed?: boolean; fetching?: boolean } = {}) =>
      act(() =>
        store.report('panel', {
          updatedAt,
          failed: extra.failed ?? false,
          fetching: extra.fetching ?? false,
        }),
      ),
    elapse: (seconds: number) => act(() => vi.advanceTimersByTime(seconds * 1000)),
  }
}

const chip = () => document.querySelector('[data-state]') as HTMLElement
const visible = () => chip().querySelector('[aria-hidden="true"]') as HTMLElement
const spoken = () => chip().querySelector('.sr-only') as HTMLElement

describe('FreshnessChip', () => {
  it('says how long ago the data arrived while live', () => {
    const { report, elapse } = setup()
    report(T0)
    expect(visible()).toHaveTextContent('updated 0s ago')
    elapse(3)
    expect(visible()).toHaveTextContent('updated 3s ago')
    expect(chip()).toHaveAttribute('data-state', 'live')
  })

  it('says updating while a request is in flight', () => {
    const { report } = setup()
    report(T0, { fetching: true })
    expect(visible()).toHaveTextContent('updating')
    expect(chip()).toHaveAttribute('data-state', 'fetching')
  })

  it('says PAUSED with the age while polling is frozen', () => {
    const { report, elapse } = setup(undefined, { paused: true })
    report(T0)
    elapse(41)
    expect(visible()).toHaveTextContent('PAUSED 41s')
    expect(chip()).toHaveAttribute('data-state', 'paused')
  })

  it('turns STALE after 45 seconds, in the warning color on its tint', () => {
    const { report, elapse } = setup()
    report(T0)
    elapse(44)
    expect(chip()).toHaveAttribute('data-state', 'live')
    elapse(8)
    expect(visible()).toHaveTextContent('STALE 52s')
    expect(chip()).toHaveAttribute('data-state', 'stale')
    expect(chip()).toHaveClass(STATUS_TEXT.warning, STATUS_TINT.warning)
  })

  it('turns NO DATA after 120 seconds, in the critical color on its tint', () => {
    const { report, elapse } = setup()
    report(T0)
    elapse(125)
    expect(visible()).toHaveTextContent('NO DATA 2m')
    expect(chip()).toHaveAttribute('data-state', 'nodata')
    expect(chip()).toHaveClass(STATUS_TEXT.critical, STATUS_TINT.critical)
  })

  it('says NO DATA at once when every request failed', () => {
    const { report } = setup()
    report(null, { failed: true })
    expect(visible()).toHaveTextContent('NO DATA')
    expect(chip()).toHaveAttribute('data-state', 'nodata')
  })

  it('never borrows the OK / WARN / CRIT shapes: those mean entity health', () => {
    const { report, elapse } = setup()
    report(T0)
    elapse(60)
    expect(chip().querySelector('svg')).toBeNull()
    expect(chip().querySelector('[data-status]')).toBeNull()
  })

  it('is a polite status region that announces a change of state, not the ticking seconds', () => {
    const { report, elapse } = setup()
    report(T0)
    expect(chip().tagName).toBe('OUTPUT')
    expect(screen.getByRole('status')).toBe(chip())
    expect(spoken()).toHaveTextContent('Data is live')
    expect(visible()).toHaveAttribute('aria-hidden', 'true')
    elapse(10)
    expect(spoken()).toHaveTextContent('Data is live')
    // A refresh is a normal part of live: it must not be announced.
    report(T0 + 10_000, { fetching: true })
    expect(spoken()).toHaveTextContent('Data is live')
    elapse(60)
    expect(spoken()).toHaveTextContent('Data is stale')
    expect(spoken().textContent).not.toMatch(/\d/)
  })
})

describe('LiveCursor', () => {
  const cursor = (state: Parameters<typeof LiveCursor>[0]['state']) => {
    const { container } = renderApp(<LiveCursor state={state} />)
    return container.querySelector('[data-state]') as HTMLElement
  }

  it('is solid when live and hidden from assistive technology', () => {
    const element = cursor('live')
    expect(element).toHaveClass('bg-primary')
    expect(element).not.toHaveClass('animate-cursor')
    expect(element).toHaveAttribute('aria-hidden', 'true')
  })

  it('blinks in steps only while a request is in flight', () => {
    expect(cursor('fetching')).toHaveClass('bg-primary', 'animate-cursor')
  })

  it('is hollow when paused', () => {
    const element = cursor('paused')
    expect(element).toHaveClass('border-primary')
    expect(element).not.toHaveClass('bg-primary')
  })

  it('is struck through in warning when stale and in critical when there is no data', () => {
    const stale = cursor('stale')
    expect(stale).toHaveClass(STATUS_TEXT.warning)
    expect(stale.querySelector('.h-px')).not.toBeNull()
    const nodata = cursor('nodata')
    expect(nodata).toHaveClass(STATUS_TEXT.critical)
    expect(nodata.querySelector('.h-px')).not.toBeNull()
  })
})

describe('FreshnessCursor (phone app bar)', () => {
  it('shows the cursor and still speaks the state', () => {
    const { report, elapse } = setup(<FreshnessCursor />)
    report(T0)
    expect(document.querySelector('[data-state="live"]')).not.toBeNull()
    elapse(130)
    expect(document.querySelector('[data-state="nodata"]')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('No data')
  })
})
