import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveContext, LiveStore, type LiveControls } from '@/app/live'
import { renderApp } from '@/test/render'
import { RefreshHairline } from './RefreshHairline'

afterEach(() => vi.unstubAllGlobals())

function setup({ paused = false, pollMs = 15_000 } = {}) {
  const store = new LiveStore()
  const controls: LiveControls = {
    pollMs,
    paused,
    togglePause: () => {},
    refreshToken: 0,
    refresh: () => {},
    store,
  }
  const { container } = renderApp(
    <LiveContext.Provider value={controls}>
      <RefreshHairline />
    </LiveContext.Provider>,
  )
  return {
    track: container.firstElementChild as HTMLElement,
    load: (updatedAt: number) =>
      act(() => store.report('panel', { updatedAt, failed: false, fetching: false })),
  }
}

describe('RefreshHairline', () => {
  it('is a 1px decorative line with no progress before the first load', () => {
    const { track } = setup()
    expect(track).toHaveAttribute('aria-hidden', 'true')
    expect(track).toHaveClass('h-px')
    expect(track.children).toHaveLength(0)
  })

  it('fills over the poll interval using a transform animation', () => {
    const { track, load } = setup({ pollMs: 15_000 })
    load(1000)
    const bar = track.firstElementChild as HTMLElement
    // The animate-refresh utility owns the keyframes and easing; the poll interval is passed as a variable.
    expect(bar).toHaveClass('animate-refresh', 'origin-left')
    expect(bar.style.getPropertyValue('--refresh-ms')).toBe('15000ms')
    expect(bar.style.animationPlayState).toBe('running')
  })

  it('starts over on every load', () => {
    const { track, load } = setup()
    load(1000)
    const first = track.firstElementChild
    load(2000)
    // A new element restarts the CSS animation from zero.
    expect(track.firstElementChild).not.toBe(first)
  })

  it('freezes while paused', () => {
    const { track, load } = setup({ paused: true })
    load(1000)
    expect((track.firstElementChild as HTMLElement).style.animationPlayState).toBe('paused')
  })

  it('leaves only the static track under reduced motion (the status bar says "next poll")', () => {
    window.localStorage.setItem('sentinel.prefs.v1', JSON.stringify({ motion: 'reduce' }))
    const { track, load } = setup()
    load(1000)
    expect(track.children).toHaveLength(0)
  })

  it('also honors the system reduced-motion setting', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const { track, load } = setup()
    load(1000)
    expect(track.children).toHaveLength(0)
  })
})
