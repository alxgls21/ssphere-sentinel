import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATUS_FRAME } from '@/ui/status'
import { VerdictBar } from './VerdictBar'
import { makeResource, renderHero } from './testing'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const bar = () => screen.getByRole('button', { name: /^Fleet status:/ })

describe('VerdictBar', () => {
  it('is one 40px line: glyph, word and how many need attention', () => {
    renderHero(<VerdictBar />)
    const button = bar()
    expect(button).toHaveAttribute('data-verdict', 'critical')
    expect(button).toHaveClass('h-10', STATUS_FRAME.critical)
    expect(button.querySelector('svg')).toHaveAttribute('data-status', 'critical')
    expect(within(button).getByText('CRITICAL')).toBeInTheDocument()
    expect(within(button).getByText('6 need attention')).toBeInTheDocument()
  })

  it('is named with the full verdict and describes where it leads', () => {
    renderHero(<VerdictBar />)
    expect(bar()).toHaveAccessibleName(
      'Fleet status: critical, 6 need attention of 81, 3 critical, 3 warning, 75 ok, mock data',
    )
    expect(bar()).toHaveAccessibleDescription(expect.stringContaining('Opens Needs attention.'))
  })

  it('scrolls to the Needs attention queue and focuses it when tapped', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderHero(
      <>
        <VerdictBar />
        <section data-panel="1" tabIndex={-1} aria-label="Needs attention" />
      </>,
    )
    await userEvent.click(bar())
    const queue = screen.getByRole('region', { name: 'Needs attention' })
    expect(scroll.mock.contexts).toContain(queue)
    expect(queue).toHaveFocus()
  })

  it('reads NO DATA with the reason, not a verdict, when there is no data', () => {
    renderHero(<VerdictBar />, {
      summary: makeResource({
        status: 'error',
        data: undefined,
        error: new Error('503'),
        updatedAt: null,
      }),
    })
    expect(bar()).toHaveAttribute('data-verdict', 'nodata')
    expect(within(bar()).getByText('NO DATA')).toBeInTheDocument()
    expect(within(bar()).getByText('no data received')).toBeInTheDocument()
    expect(bar().querySelector('svg')).toHaveAttribute('data-status', 'unknown')
  })

  it('says STALE once the data is old, without dimming its text', () => {
    vi.useFakeTimers()
    const { store } = renderHero(<VerdictBar />)
    store.report('summary', { updatedAt: Date.now(), failed: false, fetching: false })
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(within(bar()).getByText('STALE')).toBeVisible()
    expect(within(bar()).getByText('CRITICAL').closest('[class*="opacity-60"]')).toBeNull()
  })

  it('shows a skeleton after 150 ms while loading', () => {
    vi.useFakeTimers()
    const { container } = renderHero(<VerdictBar />, {
      summary: makeResource({ status: 'loading', data: undefined, updatedAt: null }),
    })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(container.querySelector('.animate-skeleton')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(container.querySelector('.animate-skeleton')).not.toBeNull()
  })

  it('takes its placement from the page', () => {
    renderHero(<VerdictBar className="sticky top-12 md:hidden" />)
    expect(bar()).toHaveClass('sticky', 'top-12', 'md:hidden')
  })
})
