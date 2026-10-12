import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline } from './Sparkline'

const series = [98, 99, 100, 99, 97, 98, 100, 99, 99, 98, 99, 99]

describe('Sparkline', () => {
  it('is one image, 64x24, whose name states the range and the latest value', () => {
    render(<Sparkline values={[98, 99, 100, 99]} label="Success rate last hour" />)
    const spark = screen.getByRole('img', {
      name: 'Success rate last hour: 98 to 100 percent, now 99',
    })
    const drawing = spark.querySelector('svg')
    expect(drawing).toHaveAttribute('viewBox', '0 0 64 24')
    expect(drawing).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws a 2px line through every point with no axes', () => {
    const { container } = render(<Sparkline values={series} label="Success rate" />)
    const line = container.querySelector('polyline')
    expect(line?.getAttribute('points')?.split(' ')).toHaveLength(12)
    expect(line).toHaveAttribute('stroke-width', '2')
    expect(line).toHaveClass('stroke-series-other')
    expect(container.querySelectorAll('line, text, title')).toHaveLength(0)
  })

  it('marks the latest point with an 8px primary dot inside a 2px panel-colored ring', () => {
    const { container } = render(<Sparkline values={series} label="Success rate" />)
    const [ring, dot] = [...container.querySelectorAll('circle')]
    expect(ring).toHaveAttribute('r', '5')
    expect(ring).toHaveClass('fill-panel')
    expect(dot).toHaveAttribute('r', '4')
    expect(dot).toHaveClass('fill-primary')
    const lastPoint = container.querySelector('polyline')?.getAttribute('points')?.split(' ').at(-1)
    expect(`${dot?.getAttribute('cx')},${dot?.getAttribute('cy')}`).toBe(lastPoint)
    expect(ring?.getAttribute('cx')).toBe(dot?.getAttribute('cx'))
  })

  it('says "no history" instead of drawing a trend for fewer than two values', () => {
    const { container, rerender } = render(<Sparkline values={[]} label="Success rate" />)
    expect(screen.getByText('no history')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Success rate: no history' })).toBeInTheDocument()
    expect(container.querySelector('polyline')).toBeNull()
    rerender(<Sparkline values={[99]} label="Success rate" />)
    expect(screen.getByText('no history')).toBeInTheDocument()
    expect(container.querySelector('circle')).toBeNull()
  })

  it('speaks the unit and honours a custom domain', () => {
    render(<Sparkline values={[10, 20, 30]} domain={[0, 50]} label="Latency" unit="milliseconds" />)
    expect(
      screen.getByRole('img', { name: 'Latency: 10 to 30 milliseconds, now 30' }),
    ).toBeInTheDocument()
  })
})
