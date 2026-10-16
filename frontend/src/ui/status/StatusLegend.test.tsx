import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusLegend } from './StatusLegend'

describe('StatusLegend', () => {
  it('lists every state with its glyph and word, offline after critical', () => {
    render(<StatusLegend />)
    const items = within(screen.getByRole('list', { name: 'Status legend' })).getAllByRole(
      'listitem',
    )
    expect(items.map((item) => item.textContent)).toEqual([
      'OK',
      'WARN',
      'CRIT',
      'OFFL',
      'UNKN',
      'IDLE',
    ])
    expect(items.map((item) => item.querySelector('svg')?.getAttribute('data-status'))).toEqual([
      'healthy',
      'warning',
      'critical',
      'offline',
      'unknown',
      'idle',
    ])
  })

  it('draws every state in a shape of its own', () => {
    render(<StatusLegend />)
    const shapes = screen
      .getAllByRole('listitem')
      .map((item) => item.querySelector('svg')?.innerHTML)
    expect(new Set(shapes).size).toBe(shapes.length)
  })

  it('explains only the states it is given, in that order', () => {
    render(<StatusLegend statuses={['offline', 'critical']} />)
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'OFFL',
      'CRIT',
    ])
  })

  it('passes a class name to the list', () => {
    render(<StatusLegend className="ml-auto" />)
    expect(screen.getByRole('list', { name: 'Status legend' })).toHaveClass('ml-auto', 'flex-wrap')
  })
})
