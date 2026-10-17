import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DemoStrip } from './DemoStrip'

describe('DemoStrip', () => {
  it('names the data and says it is not the user’s infrastructure', () => {
    render(<DemoStrip />)
    expect(screen.getByText('DEMO DATA')).toBeVisible()
    expect(screen.getByText(/not your infrastructure/)).toBeVisible()
  })
})
