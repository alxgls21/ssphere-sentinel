import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { StatusCounts } from '@/api/types'
import { GlyphCounts } from './GlyphCounts'

const counts = (over: Partial<StatusCounts>): StatusCounts => ({
  healthy: 0,
  warning: 0,
  critical: 0,
  unknown: 0,
  idle: 0,
  ...over,
})

/** Each mark with the figure beside it, in drawing order. */
const figures = (root: HTMLElement) =>
  [...root.querySelectorAll('svg')].map((svg) => [
    svg.dataset.status,
    svg.parentElement?.parentElement?.textContent,
  ])

describe('GlyphCounts', () => {
  it('draws a glyph and a number for each status that has members, worst first', () => {
    const { container } = render(
      <GlyphCounts
        counts={counts({ healthy: 11, idle: 2, unknown: 1, warning: 3, critical: 4 })}
      />,
    )
    expect(figures(container)).toEqual([
      ['critical', '4'],
      ['warning', '3'],
      ['unknown', '1'],
      ['idle', '2'],
      ['healthy', '11'],
    ])
  })

  it('draws offline apart from the critical it is part of, directly after it', () => {
    const { container } = render(
      <GlyphCounts counts={counts({ healthy: 11, warning: 3, critical: 3, offline: 2 })} />,
    )
    // 1 critical, 2 offline: the two add up to the 3 that critical holds.
    expect(figures(container)).toEqual([
      ['critical', '1'],
      ['offline', '2'],
      ['warning', '3'],
      ['healthy', '11'],
    ])
  })

  it('draws only offline when every critical member is offline', () => {
    const { container } = render(<GlyphCounts counts={counts({ critical: 2, offline: 2 })} />)
    expect(figures(container)).toEqual([['offline', '2']])
  })

  it('keeps the quiet 6px dot for healthy and full shapes for the rest, offline included', () => {
    const { container } = render(
      <GlyphCounts counts={counts({ healthy: 1, critical: 1, offline: 1 })} />,
    )
    const sizes = Object.fromEntries(
      [...container.querySelectorAll('svg')].map((svg) => [
        svg.dataset.status,
        svg.getAttribute('class'),
      ]),
    )
    expect(sizes.healthy).toContain('size-1.5')
    expect(sizes.offline).toContain('size-2.5')
  })

  it('is empty when nothing is counted', () => {
    const { container } = render(<GlyphCounts counts={counts({})} />)
    expect(container.querySelectorAll('svg')).toHaveLength(0)
  })

  it('passes className to its root', () => {
    const { container } = render(
      <GlyphCounts counts={counts({ healthy: 1 })} className="shrink-0" />,
    )
    expect(container.firstElementChild).toHaveClass('shrink-0')
  })
})
