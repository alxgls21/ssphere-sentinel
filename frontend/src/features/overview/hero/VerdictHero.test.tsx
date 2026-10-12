import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverviewSummary, StatusCounts } from '@/api/types'
import { stubFocusVisible } from '@/ui/controls/testing'
import { STATUS_EDGE, STATUS_FRAME, STATUS_TINT } from '@/ui/status'
import { NOT_COUNTED } from './verdictText'
import { VerdictHero } from './VerdictHero'
import { counts, makeResource, makeSummary, renderHero } from './testing'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A fleet whose counts are exactly these (totals are not under test here). */
function fleet(
  servers: Partial<StatusCounts>,
  containers: Partial<StatusCounts> = {},
  targets: Partial<StatusCounts> = {},
): OverviewSummary {
  return makeSummary({
    servers: { total: 0, online: 0, counts: counts(servers) },
    containers: { total: 0, running: 0, counts: counts(containers) },
    targets: { total: 0, up: 0, counts: counts(targets), successTrend: [] },
  })
}

const hero = () => screen.getByRole('button', { name: /^Fleet status:/ })

describe('VerdictHero: critical (the reference story)', () => {
  it('shows 9 of 121 needing attention beside a CRITICAL word with its glyph', () => {
    renderHero(<VerdictHero />)
    const button = hero()
    expect(button).toHaveAttribute('data-verdict', 'critical')
    expect(within(button).getByText('9')).toHaveClass('type-hero', 'text-fg')
    expect(within(button).getByText('CRITICAL')).toBeInTheDocument()
    expect(within(button).getByText('need attention of 121')).toBeInTheDocument()
    expect(button.querySelector('svg.size-6')).toHaveAttribute('data-status', 'critical')
  })

  it('draws the fleet bar without idle, then glyph-coded counts worst first', () => {
    renderHero(<VerdictHero />)
    const bar = within(hero()).getByRole('img', { name: 'Fleet: 4 critical, 5 warning, 112 ok' })
    expect(bar.querySelector('[data-status="idle"]')).toBeNull()
    expect(hero()).toHaveTextContent('4 CRIT5 WARN112 OK')
  })

  it('is named in full, with idle and the planned domains explained as its description', () => {
    renderHero(<VerdictHero />)
    const button = hero()
    expect(button).toHaveAccessibleName(
      'Fleet status: critical, 9 need attention of 121, 4 critical, 5 warning, 112 ok, mock data',
    )
    expect(button).toHaveAccessibleDescription(
      `3 idle entities are not counted. ${NOT_COUNTED} Enter opens Needs attention.`,
    )
  })

  it('wears the status frame, tint and 4px edge, and keeps the figure in text color', () => {
    renderHero(<VerdictHero />)
    const button = hero()
    const [tint, edge] = [...button.querySelectorAll(':scope > span[aria-hidden="true"]')]
    expect(button).toHaveClass(STATUS_FRAME.critical)
    expect(tint).toHaveClass(STATUS_TINT.critical)
    expect(edge).toHaveClass(STATUS_EDGE.critical, 'w-1')
  })
})

describe('VerdictHero: the other verdicts', () => {
  it('DEGRADED when there are warnings but nothing critical', () => {
    renderHero(<VerdictHero />, {
      summary: makeResource({ data: fleet({ healthy: 10, warning: 2 }, { healthy: 5 }) }),
    })
    const button = hero()
    expect(button).toHaveAttribute('data-verdict', 'degraded')
    expect(within(button).getByText('DEGRADED')).toBeInTheDocument()
    expect(button.querySelector('.type-hero')).toHaveTextContent('2')
    expect(button.querySelector('svg.size-6')).toHaveAttribute('data-status', 'warning')
    expect(button).toHaveClass(STATUS_FRAME.warning)
  })

  it('PARTIAL when something is unobserved: ring glyph, no tint', () => {
    renderHero(<VerdictHero />, {
      summary: makeResource({ data: fleet({ healthy: 10, unknown: 2 }) }),
    })
    const button = hero()
    expect(button).toHaveAttribute('data-verdict', 'partial')
    expect(within(button).getByText('PARTIAL')).toBeInTheDocument()
    expect(button.querySelector('svg.size-6')).toHaveAttribute('data-status', 'unknown')
    expect(button.querySelector(':scope > span[aria-hidden="true"]')).toHaveClass(
      STATUS_TINT.unknown,
    )
    expect(button).toHaveClass(STATUS_FRAME.unknown)
  })

  it('NOMINAL when everything is fine: zero needs attention, only the OK count listed', () => {
    renderHero(<VerdictHero />, {
      summary: makeResource({ data: fleet({ healthy: 16 }, { healthy: 60, idle: 2 }) }),
    })
    const button = hero()
    expect(button).toHaveAttribute('data-verdict', 'nominal')
    expect(within(button).getByText('NOMINAL')).toBeInTheDocument()
    expect(button.querySelector('.type-hero')).toHaveTextContent('0')
    expect(within(button).getByText('need attention of 76')).toBeInTheDocument()
    expect(button).toHaveTextContent('76 OK')
    expect(button.querySelector('svg.size-6')).toHaveAttribute('data-status', 'healthy')
    expect(button.querySelector(':scope > span[aria-hidden="true"]')).toHaveClass(
      STATUS_TINT.healthy,
    )
  })

  it('caps the figure at 999+', () => {
    renderHero(<VerdictHero />, {
      summary: makeResource({ data: fleet({ critical: 1200, healthy: 5 }) }),
    })
    expect(within(hero()).getByText('999+')).toBeInTheDocument()
  })
})

describe('VerdictHero: NO DATA', () => {
  it('replaces the verdict once the data is older than 120 s: ring, em dash, 60% opacity, empty bar', () => {
    vi.useFakeTimers()
    const { store } = renderHero(<VerdictHero />)
    store.report('summary', { updatedAt: Date.now(), failed: false, fetching: false })
    act(() => {
      vi.advanceTimersByTime(121_000)
    })
    const button = hero()
    expect(button).toHaveAttribute('data-verdict', 'nodata')
    expect(within(button).getByText('NO DATA')).toBeInTheDocument()
    expect(within(button).getByText('—')).toHaveClass('type-hero')
    expect(within(button).getByText('data older than 2 min')).toBeInTheDocument()
    expect(button.querySelector('svg.size-6')).toHaveAttribute('data-status', 'unknown')
    expect(within(button).getByText('—').closest('[class*="opacity-60"]')).not.toBeNull()
    // The old numbers must not survive under a NO DATA word.
    expect(within(button).getByRole('img', { name: 'Fleet: none' })).toBeInTheDocument()
    expect(button).not.toHaveTextContent('CRIT')
    expect(button).toHaveAccessibleName('Fleet status: no data, data older than 2 min, mock data')
    expect(button).toHaveClass(STATUS_FRAME.unknown)
    expect(button.querySelector(':scope > span[aria-hidden="true"]')).toHaveClass(
      STATUS_TINT.unknown,
    )
  })

  it('is what a failed first load reads', () => {
    renderHero(<VerdictHero />, {
      summary: makeResource({
        status: 'error',
        data: undefined,
        error: new Error('503'),
        updatedAt: null,
      }),
    })
    const button = hero()
    expect(button).toHaveAttribute('data-verdict', 'nodata')
    expect(within(button).getByText('—')).toBeInTheDocument()
    expect(within(button).getByText('no data received')).toBeInTheDocument()
  })

  it('reads NO DATA, not NOMINAL, when nothing is monitored yet', () => {
    renderHero(<VerdictHero />, { summary: makeResource({ data: fleet({}) }) })
    expect(hero()).toHaveAttribute('data-verdict', 'nodata')
    expect(within(hero()).getByText('nothing monitored yet')).toBeInTheDocument()
  })
})

describe('VerdictHero: stale and loading', () => {
  it('keeps the verdict, dims only the large figure and the bar, and says STALE once the data is old', () => {
    vi.useFakeTimers()
    const { store } = renderHero(<VerdictHero />)
    store.report('summary', { updatedAt: Date.now(), failed: false, fetching: false })
    expect(within(hero()).getByText('9').closest('[class*="opacity-60"]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(hero()).toHaveAttribute('data-verdict', 'critical')
    // Large text may dim (3:1 is enough); the word and the caption never do (they would fall below AA).
    expect(within(hero()).getByText('9').closest('[class*="opacity-60"]')).not.toBeNull()
    expect(within(hero()).getByText('CRITICAL').closest('[class*="opacity-60"]')).toBeNull()
    expect(within(hero()).getByText('STALE')).toBeVisible()
  })

  it('keeps the verdict undimmed while the operator has paused updates, however long', () => {
    vi.useFakeTimers()
    const { store } = renderHero(<VerdictHero />, { paused: true })
    store.report('summary', { updatedAt: Date.now(), failed: false, fetching: false })
    act(() => {
      vi.advanceTimersByTime(300_000)
    })
    expect(hero()).toHaveAttribute('data-verdict', 'critical')
    expect(within(hero()).getByText('CRITICAL').closest('[class*="opacity-60"]')).toBeNull()
  })

  it('shows a skeleton after 150 ms while loading, marked busy, and is not a button yet', () => {
    vi.useFakeTimers()
    const { container } = renderHero(<VerdictHero />, {
      summary: makeResource({ status: 'loading', data: undefined, updatedAt: null }),
    })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(container.querySelector('[aria-busy="true"]')).toHaveTextContent('Loading fleet status')
    expect(container.querySelector('.animate-skeleton')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(container.querySelectorAll('.animate-skeleton').length).toBeGreaterThan(0)
  })
})

describe('VerdictHero: tooltip and keyboard', () => {
  it('explains what is not counted on keyboard focus', async () => {
    stubFocusVisible()
    renderHero(<VerdictHero />)
    await userEvent.tab()
    expect(hero()).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('3 idle entities are not counted.')
    expect(tip).toHaveTextContent(NOT_COUNTED)
  })

  it('moves focus to the Needs attention panel on Enter', async () => {
    renderHero(
      <>
        <VerdictHero />
        <section data-panel="1" tabIndex={-1} aria-label="Needs attention" />
      </>,
    )
    await userEvent.tab()
    expect(hero()).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveFocus()
  })

  it('does nothing when the queue is not on the page', async () => {
    renderHero(<VerdictHero />)
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    expect(hero()).toHaveFocus()
  })
})
