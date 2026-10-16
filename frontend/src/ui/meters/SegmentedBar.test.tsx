import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { StatusCounts } from '@/api/types'
import { spokenStatus } from '@/lib/blocks'
import type { DisplayStatus } from '@/lib/status'
import { STATUS_NAME } from '@/ui/status'
import { SegmentedBar } from './SegmentedBar'

const counts = (partial: Partial<StatusCounts>): StatusCounts => ({
  healthy: 0,
  warning: 0,
  critical: 0,
  unknown: 0,
  idle: 0,
  ...partial,
})

const segments = (bar: HTMLElement) => [...bar.querySelectorAll<HTMLElement>('[data-status]')]

describe('SegmentedBar', () => {
  it('is an image named after every non-zero count, worst first', () => {
    render(
      <SegmentedBar
        counts={counts({ healthy: 13, warning: 2, critical: 1 })}
        height={6}
        label="Servers"
      />,
    )
    expect(
      screen.getByRole('img', { name: 'Servers: 1 critical, 2 warning, 13 ok' }),
    ).toBeInTheDocument()
  })

  it('speaks the same status names as ui/status', () => {
    const all: DisplayStatus[] = ['critical', 'offline', 'warning', 'unknown', 'idle', 'healthy']
    for (const status of all) expect(spokenStatus(status)).toBe(STATUS_NAME[status])
  })

  it('orders segments critical, warning, unknown, idle, healthy whatever the key order', () => {
    render(
      <SegmentedBar
        counts={{ healthy: 9, idle: 1, unknown: 2, warning: 3, critical: 4 }}
        height={8}
        label="Fleet"
      />,
    )
    const bar = screen.getByRole('img', { name: /^Fleet:/ })
    expect(segments(bar).map((segment) => segment.dataset.status)).toEqual([
      'critical',
      'warning',
      'unknown',
      'idle',
      'healthy',
    ])
  })

  it('omits statuses with no members', () => {
    render(<SegmentedBar counts={counts({ healthy: 3, critical: 1 })} height={8} label="Fleet" />)
    const bar = screen.getByRole('img')
    expect(segments(bar).map((segment) => segment.dataset.status)).toEqual(['critical', 'healthy'])
  })

  it('titles each segment with its word, count and the total', () => {
    render(
      <SegmentedBar
        counts={counts({ healthy: 37, warning: 2, critical: 1 })}
        height={6}
        label="Servers"
      />,
    )
    expect(screen.getByTitle('CRIT 1 of 40')).toBeInTheDocument()
    expect(screen.getByTitle('WARN 2 of 40')).toBeInTheDocument()
    expect(screen.getByTitle('OK 37 of 40')).toBeInTheDocument()
  })

  it('draws no segment titles where a tooltip already describes the bar, and still names every count', () => {
    render(
      <SegmentedBar
        counts={counts({ healthy: 37, warning: 2, critical: 1 })}
        height={8}
        label="Servers"
        segmentTitles={false}
      />,
    )
    const bar = screen.getByRole('img', { name: 'Servers: 1 critical, 2 warning, 37 ok' })
    expect(bar.querySelector('[title]')).toBeNull()
    expect(segments(bar)).toHaveLength(3)
  })

  it('shares width by count and floors every segment at 3px so one failure stays visible', () => {
    render(<SegmentedBar counts={counts({ critical: 1, healthy: 123 })} height={6} label="Fleet" />)
    const [critical, healthy] = segments(screen.getByRole('img'))
    expect(critical?.style.flexGrow).toBe('1')
    expect(healthy?.style.flexGrow).toBe('123')
    // 0.75 spacing steps = 0.1875rem = 3px at the default root size.
    expect(critical).toHaveClass('min-w-0.75')
    expect(healthy).toHaveClass('min-w-0.75')
  })

  it('rounds only the outer ends', () => {
    render(<SegmentedBar counts={counts({ critical: 1, healthy: 3 })} height={8} label="Fleet" />)
    for (const segment of segments(screen.getByRole('img'))) {
      expect(segment).toHaveClass('first:rounded-l-sm', 'last:rounded-r-sm')
      expect(segment.className).not.toMatch(/(^|\s)rounded(-sm)?(\s|$)/)
    }
  })

  it('draws the unknown segment hollow and the idle one flat, not as plain color fills', () => {
    render(<SegmentedBar counts={counts({ unknown: 1, idle: 1 })} height={8} label="Fleet" />)
    const [unknown, idle] = segments(screen.getByRole('img'))
    expect(unknown).toHaveClass('border')
    expect(unknown?.className).not.toMatch(/\bbg-/)
    expect(idle).toHaveClass('h-1/2')
  })

  it('supports the two thicknesses', () => {
    const { rerender } = render(
      <SegmentedBar counts={counts({ healthy: 1 })} height={6} label="Fleet" />,
    )
    expect(screen.getByRole('img')).toHaveClass('h-1.5')
    rerender(<SegmentedBar counts={counts({ healthy: 1 })} height={8} label="Fleet" />)
    expect(screen.getByRole('img')).toHaveClass('h-2')
  })

  it('renders an empty hairline track for a zero total', () => {
    render(<SegmentedBar counts={counts({})} height={8} label="Servers" />)
    const track = screen.getByRole('img', { name: 'Servers: none' })
    expect(track).toBeEmptyDOMElement()
    expect(track).toHaveClass('border-border')
  })

  it('renders the planned variant as a dashed outline with its text instead of a bar', () => {
    render(
      <SegmentedBar
        counts={counts({ healthy: 4 })}
        height={8}
        label="SNMP devices"
        planned
        plannedText="no SNMP data"
      />,
    )
    const planned = screen.getByRole('img', { name: 'SNMP devices: no SNMP data' })
    expect(planned).toHaveTextContent('no SNMP data')
    expect(planned).toHaveClass('border-dashed')
    expect(planned.querySelector('[data-status]')).toBeNull()
  })

  it('passes className to the root', () => {
    render(
      <SegmentedBar counts={counts({ healthy: 1 })} height={8} label="Fleet" className="flex-1" />,
    )
    expect(screen.getByRole('img')).toHaveClass('flex-1')
  })
})

describe('SegmentedBar with offline servers', () => {
  const fleet = counts({ healthy: 11, warning: 3, critical: 3, unknown: 1, idle: 2, offline: 2 })

  it('names offline apart from the critical it is part of, and keeps every total', () => {
    render(<SegmentedBar counts={fleet} height={8} label="Servers" />)
    expect(
      screen.getByRole('img', {
        name: 'Servers: 1 critical, 2 offline, 3 warning, 1 unknown, 2 idle, 11 ok',
      }),
    ).toBeInTheDocument()
  })

  it('draws the offline segment directly after critical', () => {
    render(<SegmentedBar counts={fleet} height={8} label="Fleet" />)
    const bar = screen.getByRole('img', { name: /^Fleet:/ })
    expect(segments(bar).map((segment) => segment.dataset.status)).toEqual([
      'critical',
      'offline',
      'warning',
      'unknown',
      'idle',
      'healthy',
    ])
  })

  it('shares the width by count: critical without its offline members, offline on its own', () => {
    render(<SegmentedBar counts={fleet} height={8} label="Fleet" />)
    const [critical, offline] = segments(screen.getByRole('img'))
    expect(critical?.style.flexGrow).toBe('1')
    expect(offline?.style.flexGrow).toBe('2')
  })

  it('has no critical segment when every critical member is offline', () => {
    render(
      <SegmentedBar
        counts={counts({ critical: 1, offline: 1, healthy: 9 })}
        height={6}
        label="Fleet"
      />,
    )
    const bar = screen.getByRole('img', { name: 'Fleet: 1 offline, 9 ok' })
    expect(segments(bar).map((segment) => segment.dataset.status)).toEqual(['offline', 'healthy'])
  })

  it('titles the segment with its word, count and the total', () => {
    render(<SegmentedBar counts={fleet} height={8} label="Fleet" />)
    expect(screen.getByTitle('OFFL 2 of 20')).toBeInTheDocument()
    expect(screen.getByTitle('CRIT 1 of 20')).toBeInTheDocument()
  })

  it('keeps the 3px minimum, the 2px gaps and the rounded outer ends', () => {
    render(
      <SegmentedBar
        counts={counts({ critical: 1, offline: 1, healthy: 123 })}
        height={6}
        label="Fleet"
      />,
    )
    const bar = screen.getByRole('img')
    const [offline, healthy] = segments(bar)
    expect(offline).toHaveClass('min-w-0.75', 'basis-0', 'first:rounded-l-sm', 'last:rounded-r-sm')
    expect(healthy).toHaveClass('min-w-0.75')
    expect(bar).toHaveClass('gap-0.5')
  })

  describe('tells offline from the other segments without color', () => {
    const drawn = () => {
      const { container } = render(<SegmentedBar counts={fleet} height={8} label="Fleet" />)
      return segments(container.firstElementChild as HTMLElement)
    }

    it('is two thin bars with a break between them, where the others are one piece', () => {
      const [critical, offline, warning, unknown, idle, healthy] = drawn()
      expect(offline?.children).toHaveLength(2)
      for (const other of [critical, warning, unknown, idle, healthy])
        expect(other?.children, other?.dataset.status).toHaveLength(0)
      expect(offline).toHaveClass('flex-col', 'gap-0.5')
      expect([...(offline?.children ?? [])].map((half) => half.className)).toEqual([
        expect.stringContaining('bg-offline'),
        expect.stringContaining('bg-offline'),
      ])
    })

    it('is neither hollow like unknown nor a half-height bar like idle', () => {
      const offline = drawn()[1]
      expect(offline).not.toHaveClass('border')
      expect(offline).not.toHaveClass('h-1/2')
      expect(offline?.className).not.toMatch(/\bbg-/)
    })

    it('uses no gradient and not the hatch that means mock data', () => {
      const offline = drawn()[1] as HTMLElement
      for (const part of [offline, ...offline.children]) {
        expect(part.className).not.toMatch(/gradient|hatch/)
        expect(part.getAttribute('style') ?? '').not.toMatch(/gradient|background/)
      }
    })
  })
})
