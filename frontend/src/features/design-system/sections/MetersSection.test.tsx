import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import { MetersSection } from './MetersSection'

beforeEach(() => stubFocusVisible())
afterEach(() => vi.restoreAllMocks())

/** The sparkline specimens: every sparkline that carries its bucket times. */
const specimens = () => screen.getAllByRole('img', { name: /CPU history of api-01/ })

describe('sparkline specimens', () => {
  it('shows a gap, a host that stopped reporting, lone samples and a short series', () => {
    renderApp(<MetersSection />)
    const [gap, stopped, lone, short] = specimens()
    expect(specimens()).toHaveLength(4)

    // A gap breaks the line in two and keeps its width.
    expect(gap?.querySelectorAll('polyline')).toHaveLength(2)
    expect(gap).toHaveAccessibleName(/10 of 60 samples missing/)
    expect(gap?.querySelector('.fill-primary')).not.toBeNull()

    // Stopped reporting: a hollow last sample and a dashed tail instead of an end dot.
    expect(stopped?.querySelector('.fill-primary')).toBeNull()
    expect(stopped?.querySelector('path[stroke-dasharray]')).not.toBeNull()
    expect(stopped).toHaveAccessibleName(/no samples since/)

    // Lone samples are dots, apart from the runs.
    expect(lone?.querySelectorAll('polyline')).toHaveLength(3)
    expect(lone?.querySelectorAll('circle.fill-series-other')).toHaveLength(2)

    expect(short?.querySelectorAll('polyline')).toHaveLength(1)
    expect(short).toHaveAccessibleName(/last 2 minutes: 14:04 to 14:05 UTC/)
  })

  it('leaves the tile specimens plain: no tab stop, no bucket times', () => {
    renderApp(<MetersSection />)
    const tile = screen.getByRole('img', {
      name: 'Success rate, last hour: 97 to 100 percent, now 99',
    })
    expect(tile).not.toHaveAttribute('tabindex')
    expect(
      screen.getByRole('img', { name: 'Success rate, no history: no history' }),
    ).toBeInTheDocument()
  })

  it('opens the figures of a specimen on keyboard focus', async () => {
    renderApp(<MetersSection />)
    const [gap] = specimens()
    ;(gap as HTMLElement).focus()
    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('10 of 60 samples missing')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
