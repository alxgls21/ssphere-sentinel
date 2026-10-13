import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ModeContext } from '@/app/mode'
import { DemoStrip } from './DemoStrip'

describe('DemoStrip', () => {
  it('names the data and says it is not the user’s infrastructure', () => {
    render(<DemoStrip />)
    expect(screen.getByText('DEMO DATA')).toBeVisible()
    expect(screen.getByText(/not your infrastructure/)).toBeVisible()
  })

  it('warns that the customer and site filter does not reach it, when the filter is real', () => {
    render(
      <ModeContext.Provider value="http">
        <DemoStrip />
      </ModeContext.Provider>,
    )
    expect(screen.getByText(/ignore the customer and site filter/)).toBeVisible()
  })

  it('does not mention a filter that is not real in mock mode', () => {
    render(<DemoStrip />)
    expect(screen.queryByText(/customer and site filter/)).toBeNull()
  })
})
