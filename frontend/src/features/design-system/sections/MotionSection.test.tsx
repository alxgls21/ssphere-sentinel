import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import { MotionSection } from './MotionSection'

afterEach(() => vi.restoreAllMocks())

function prefersReducedMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: reduce && query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

describe('MotionSection', () => {
  it('shows every animation the console uses, each with a replay button', () => {
    renderApp(<MotionSection />)
    for (const utility of [
      'animate-flash',
      'animate-crit-in',
      'animate-cursor',
      'animate-skeleton',
      'animate-overlay-in',
    ]) {
      expect(screen.getByRole('heading', { name: utility })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Replay ${utility}` })).toBeInTheDocument()
    }
  })

  it('uses the real utilities, so the page shows what the console runs', () => {
    renderApp(<MotionSection />)
    expect(screen.getByText('142 ms')).toHaveClass('animate-flash')
    expect(screen.getByText('edge-gw-02').parentElement).toHaveClass('animate-crit-in')
    expect(document.querySelector('[data-state="fetching"]')).toHaveClass('animate-cursor')
    expect(document.querySelector('.animate-skeleton')).not.toBeNull()
    expect(screen.getByText('Refresh now')).toHaveClass('animate-overlay-in')
  })

  it('replays by creating the animated element again, which is what restarts a CSS animation', async () => {
    const user = userEvent.setup()
    renderApp(<MotionSection />)
    const before = screen.getByText('142 ms')
    await user.click(screen.getByRole('button', { name: 'Replay animate-flash' }))
    const after = screen.getByText('142 ms')
    expect(after).not.toBe(before)
    expect(before).not.toBeInTheDocument()
  })

  it('replays one animation without restarting the others', async () => {
    const user = userEvent.setup()
    renderApp(<MotionSection />)
    const crit = screen.getByText('edge-gw-02')
    await user.click(screen.getByRole('button', { name: 'Replay animate-flash' }))
    expect(screen.getByText('edge-gw-02')).toBe(crit)
  })

  it('shows all five cursor states, whether or not they move', () => {
    renderApp(<MotionSection />)
    for (const state of ['live', 'fetching', 'paused', 'stale', 'nodata']) {
      expect(screen.getByText(state)).toBeInTheDocument()
      expect(document.querySelector(`[data-state="${state}"]`)).not.toBeNull()
    }
  })

  it('says when motion is reduced, and that nothing below will move', () => {
    prefersReducedMotion(true)
    renderApp(<MotionSection />)
    expect(screen.getByText(/Reduced motion is on\./)).toHaveTextContent(
      'Every animation below is removed',
    )
  })

  it('says when motion is not reduced', () => {
    prefersReducedMotion(false)
    renderApp(<MotionSection />)
    expect(screen.getByText(/Reduced motion is off\./)).toBeInTheDocument()
  })
})
