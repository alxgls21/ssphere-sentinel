import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CellMeter } from './CellMeter'

const cells = (root: HTMLElement) => root.querySelectorAll('[data-cell]').length
const filled = (root: HTMLElement) => root.querySelectorAll('[data-cell="filled"]').length

describe('CellMeter', () => {
  it('exposes a meter with its range, value and a spoken threshold state', () => {
    render(<CellMeter percent={91} label="CPU of api-02" />)
    const meter = screen.getByRole('meter', { name: 'CPU of api-02' })
    expect(meter).toHaveAttribute('min', '0')
    expect(meter).toHaveAttribute('max', '100')
    expect(meter).toHaveAttribute('value', '91')
    expect(meter).toHaveAttribute('aria-valuetext', '91 percent, warning')
  })

  it('names critical from 95% and states nothing extra below 80%', () => {
    const { rerender } = render(<CellMeter percent={95} label="Disk of db-01" />)
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '95 percent, critical')
    rerender(<CellMeter percent={79} label="Disk of db-01" />)
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '79 percent')
    rerender(<CellMeter percent={4.2} label="Disk of db-01" />)
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '4.2 percent')
  })

  it('draws cells in 5% steps with the rounding rule (82% lights 16 of 20)', () => {
    const { container, rerender } = render(<CellMeter percent={82} label="CPU" />)
    expect(cells(container)).toBe(20)
    expect(filled(container)).toBe(16)
    rerender(<CellMeter percent={0} label="CPU" />)
    expect(filled(container)).toBe(0)
    rerender(<CellMeter percent={100} label="CPU" />)
    expect(filled(container)).toBe(20)
  })

  it('keeps the drawing out of the accessibility tree: the meter alone speaks', () => {
    const { container } = render(<CellMeter percent={82} label="CPU of api-02" />)
    expect(screen.getAllByRole('meter')).toHaveLength(1)
    expect(container.querySelector('[data-cell]')?.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('honours a different cell count', () => {
    const { container } = render(<CellMeter percent={50} label="CPU" cells={10} />)
    expect(cells(container)).toBe(10)
    expect(filled(container)).toBe(5)
  })

  it('shows a threshold glyph only from 80%: triangle for warning, diamond for critical', () => {
    const { rerender, container } = render(<CellMeter percent={79} label="CPU" />)
    expect(container.querySelector('svg')).toBeNull()
    rerender(<CellMeter percent={80} label="CPU" />)
    expect(container.querySelector('svg')).toHaveAttribute('data-status', 'warning')
    rerender(<CellMeter percent={95} label="CPU" />)
    expect(container.querySelector('svg')).toHaveAttribute('data-status', 'critical')
  })

  it('prints the value beside the cells, whole numbers from 10% and one decimal below', () => {
    const { rerender } = render(<CellMeter percent={82} label="CPU" />)
    expect(screen.getByText('82%')).toBeInTheDocument()
    rerender(<CellMeter percent={100} label="CPU" />)
    expect(screen.getByText('100%')).toBeInTheDocument()
    rerender(<CellMeter percent={4.2} label="CPU" />)
    expect(screen.getByText('4.2%')).toBeInTheDocument()
  })

  it('shows empty cells and "no data" without a sample, and claims no value', () => {
    const { container } = render(<CellMeter percent={null} label="CPU of edge-gw-02" />)
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    // Spoken by a visually hidden twin, shown by the drawing.
    expect(screen.getByText('CPU of edge-gw-02: no data')).toBeInTheDocument()
    expect(screen.getByText('no data')).toBeInTheDocument()
    expect(cells(container)).toBe(20)
    expect(filled(container)).toBe(0)
  })

  it('treats a non-finite sample like a missing one', () => {
    render(<CellMeter percent={Number.NaN} label="CPU" />)
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect(screen.getByText('CPU: no data')).toBeInTheDocument()
  })

  it('clamps readings outside 0-100', () => {
    const { container } = render(<CellMeter percent={140} label="CPU" />)
    expect(screen.getByRole('meter')).toHaveAttribute('value', '100')
    expect(filled(container)).toBe(20)
  })
})
