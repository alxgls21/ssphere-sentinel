import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTime } from '@/lib/format'
import { stubFocusVisible } from '@/ui/controls/testing'
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

  it('ends a stale series in a hollow mark instead of the dot, and calls its newest value the last', () => {
    const { container } = render(
      <Sparkline values={[98, 99, 100, 99]} label="Success rate last hour" stale />,
    )
    expect(
      screen.getByRole('img', { name: 'Success rate last hour: 98 to 100 percent, last 99' }),
    ).toBeInTheDocument()
    const marks = [...container.querySelectorAll('circle')]
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveAttribute('r', '3')
    expect(marks[0]).toHaveClass('fill-panel', 'stroke-fg-muted')
    expect(container.querySelector('.fill-primary')).toBeNull()
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

const MINUTE = 60_000
const START = Date.parse('2026-10-12T13:00:00Z')
const times = (count: number) => Array.from({ length: count }, (_, i) => START + i * MINUTE)
const polylines = (root: HTMLElement) => [...root.querySelectorAll('polyline')]
const dots = (root: HTMLElement) => root.querySelectorAll('circle')

describe('Sparkline with missing samples', () => {
  it('breaks the line at a gap instead of drawing across it', () => {
    const { container } = render(
      <Sparkline values={[10, 20, null, null, 50, 60]} label="CPU of api-01" />,
    )
    const [before, after] = polylines(container).map((line) =>
      (line.getAttribute('points') ?? '').split(' ').map((point) => Number(point.split(',')[0])),
    )
    expect(before).toHaveLength(2)
    expect(after).toHaveLength(2)
    // The missing buckets keep their width: three bucket pitches (58px over five) separate the runs.
    expect((after?.[0] ?? 0) - (before?.[1] ?? 0)).toBeCloseTo((3 * 58) / 5, 1)
  })

  it('draws every real sample and no other point', () => {
    const { container } = render(
      <Sparkline values={[10, 20, null, 40, null, 60, 70]} label="CPU of api-01" />,
    )
    const drawn = polylines(container).flatMap((line) => line.getAttribute('points')?.split(' '))
    // Five samples: a run of two, a lone one (a dot) and a run of two ending at the newest bucket.
    expect(drawn).toHaveLength(4)
    expect(dots(container)).toHaveLength(3)
  })

  it('draws a lone sample between gaps as a dot, smaller than the end dot', () => {
    const { container } = render(
      <Sparkline values={[10, null, 30, null, 50, 60]} label="CPU of api-01" />,
    )
    const [first, second, ring, end] = [...dots(container)]
    expect(polylines(container)).toHaveLength(1)
    expect(first).toHaveClass('fill-series-other')
    expect(second).toHaveClass('fill-series-other')
    expect(Number(first?.getAttribute('r'))).toBeLessThan(Number(end?.getAttribute('r')))
    expect(ring).toHaveClass('fill-panel')
    expect(end).toHaveClass('fill-primary')
  })

  it('does not put a lone dot under the end dot when the newest sample stands alone', () => {
    const { container } = render(<Sparkline values={[10, 20, null, 60]} label="CPU of api-01" />)
    expect(polylines(container)).toHaveLength(1)
    expect([...dots(container)].map((dot) => dot.getAttribute('r'))).toEqual(['5', '4'])
  })

  it('marks the end only when the newest bucket has a sample', () => {
    const { container } = render(<Sparkline values={[10, 20, 30, 40]} label="CPU of api-01" />)
    expect(container.querySelector('.fill-primary')).not.toBeNull()
    expect(container.querySelector('path')).toBeNull()
  })

  it('draws a series that ends on a gap with a hollow last sample and a dashed tail, and no end dot', () => {
    const { container } = render(
      <Sparkline values={[10, 20, 30, null, null, null]} label="CPU of api-01" />,
    )
    expect(container.querySelector('.fill-primary')).toBeNull()
    const tail = container.querySelector('path')
    expect(tail).toHaveAttribute('stroke-dasharray')
    expect(tail).toHaveClass('stroke-fg-faint')
    const mark = container.querySelector('circle')
    expect(mark).toHaveClass('fill-panel', 'stroke-fg-muted')
    // The line ends on the last real sample, and the hollow mark sits on it.
    const lastPoint = polylines(container)[0]?.getAttribute('points')?.split(' ').at(-1)
    expect(`${mark?.getAttribute('cx')},${mark?.getAttribute('cy')}`).toBe(lastPoint)
    // The tail starts there and runs to the last bucket, below the 0% level.
    const d = tail?.getAttribute('d') ?? ''
    expect(d.startsWith(`M${mark?.getAttribute('cx')} `)).toBe(true)
    expect(Number(d.match(/^M\S+ (\S+)H/)?.[1])).toBeGreaterThan(19)
  })

  it('says "no history" when no sample is left to draw, whatever the buckets', () => {
    const { container } = render(
      <Sparkline values={[null, null, null, null]} label="CPU of api-01" />,
    )
    expect(screen.getByText('no history')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'CPU of api-01: no history' })).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('names the gaps in its accessible name', () => {
    render(<Sparkline values={[10, null, 30, 40]} label="CPU of api-01" />)
    expect(
      screen.getByRole('img', {
        name: 'CPU of api-01: 10 to 40 percent, now 40, 1 of 4 samples missing',
      }),
    ).toBeInTheDocument()
  })
})

describe('Sparkline figures', () => {
  beforeEach(() => stubFocusVisible())
  afterEach(() => vi.restoreAllMocks())

  const stopped = [12, 20, 78, 40, null, null]

  const inspectable = (over: Partial<Parameters<typeof Sparkline>[0]> = {}) => (
    <>
      <Sparkline
        values={stopped}
        times={times(6)}
        label="CPU history of api-01, last 6 minutes"
        inspectable
        {...over}
      />
      <button type="button">after</button>
    </>
  )

  it('carries the figures in its accessible name: period, now, min, max, average, gaps', () => {
    render(
      <Sparkline
        values={[12, 20, 78, 40]}
        times={times(4)}
        label="CPU history of api-01, last 4 minutes"
        inspectable
      />,
    )
    expect(
      screen.getByRole('img', {
        name: 'CPU history of api-01, last 4 minutes: 13:00 to 13:03 UTC, now 40 percent, min 12 percent, max 78 percent, average 37.5 percent, no samples missing',
      }),
    ).toBeInTheDocument()
  })

  it('says when a host went quiet, in the chosen timezone, and does not call the last value "now"', () => {
    render(inspectable())
    const spark = screen.getByRole('img')
    expect(spark).toHaveAccessibleName(/last 40 percent/)
    expect(spark).toHaveAccessibleName(/2 of 6 samples missing, no samples since 13:04 UTC$/)
    expect(spark).not.toHaveAccessibleName(/now/)
  })

  it('is one tab stop that opens the same figures as a tooltip on keyboard focus', async () => {
    render(inspectable())
    await userEvent.tab()
    const spark = screen.getByRole('img')
    expect(spark).toHaveFocus()
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('CPU history of api-01, last 6 minutes')
    for (const figure of [
      '13:00 to 13:05 UTC',
      'last 40 percent',
      'min 12 percent',
      'max 78 percent',
      'average 37.5 percent',
      '2 of 6 samples missing',
      'no samples since 13:04 UTC',
    ]) {
      expect(tooltip).toHaveTextContent(figure)
    }
    expect(spark).toHaveAttribute('aria-describedby', tooltip.id)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    render(inspectable())
    await userEvent.tab()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('writes the times in the chosen timezone', async () => {
    render(inspectable({ tz: 'local' }))
    const [first, last] = [START, START + 5 * MINUTE].map((ms) => formatTime(ms, 'local', false))
    expect(screen.getByRole('img')).toHaveAccessibleName(
      new RegExp(`${first} to ${last} local, last 40 percent`),
    )
  })

  it('is not a tab stop unless it is inspectable (inside a link the host carries the numbers)', async () => {
    render(inspectable({ inspectable: false }))
    expect(screen.getByRole('img')).not.toHaveAttribute('tabindex')
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
  })

  it('has no tab stop and no tooltip when there is no history to inspect', async () => {
    render(inspectable({ values: [null, null, null, null, null, null] }))
    expect(screen.getByRole('img')).not.toHaveAttribute('tabindex')
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
  })

  it('still says what it can without bucket times', async () => {
    render(<Sparkline values={[10, 20, null, 40]} label="CPU" inspectable />)
    await userEvent.tab()
    expect(screen.getByRole('tooltip')).toHaveTextContent('10 to 40 percent')
    expect(screen.getByRole('tooltip')).toHaveTextContent('1 of 4 samples missing')
  })
})
