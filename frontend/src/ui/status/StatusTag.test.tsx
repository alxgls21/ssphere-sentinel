import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DisplayStatus } from '@/lib/status'
import { StatusTag } from './StatusTag'
import { STATUS_TEXT, STATUS_TINT, STATUS_WORD } from './style'

const STATES: readonly DisplayStatus[] = [
  'healthy',
  'warning',
  'critical',
  'offline',
  'unknown',
  'idle',
]

describe('StatusTag', () => {
  it.each(STATES)('shows %s as a glyph, its word and its color', (status) => {
    const { container } = render(<StatusTag status={status} />)
    const tag = container.firstElementChild as HTMLElement
    expect(tag).toHaveAttribute('data-status', status)
    expect(tag).toHaveClass(STATUS_TEXT[status])
    expect(tag).toHaveTextContent(STATUS_WORD[status])
    expect(tag.querySelector('svg')).toHaveAttribute('data-status', status)
  })

  it('lets a domain word replace the class word', () => {
    render(<StatusTag status="offline" word="OFFLINE" />)
    expect(screen.getByText('OFFLINE')).toBeInTheDocument()
    expect(screen.queryByText('OFFL')).toBeNull()
  })

  it('says OFFL for offline and CRIT for critical: the same word never names both', () => {
    const { container, rerender } = render(<StatusTag status="offline" />)
    expect(container).toHaveTextContent('OFFL')
    rerender(<StatusTag status="critical" />)
    expect(container).toHaveTextContent('CRIT')
    expect(container).not.toHaveTextContent('OFFL')
  })

  it('draws a different glyph for offline and critical', () => {
    const { container, rerender } = render(<StatusTag status="offline" />)
    const offline = container.querySelector('svg')?.innerHTML
    rerender(<StatusTag status="critical" />)
    expect(container.querySelector('svg')?.innerHTML).not.toBe(offline)
  })

  it('puts the word on the status tint in the tag variant, at least six characters wide', () => {
    const { container } = render(<StatusTag status="offline" word="OFFLINE" variant="tag" />)
    const tag = container.firstElementChild as HTMLElement
    expect(tag).toHaveClass(STATUS_TINT.offline, 'bg-offline-tint', 'min-w-[6ch]', 'rounded-sm')
    expect(tag).toHaveClass('text-offline')
  })

  it('has no tint in the plain variant', () => {
    const { container } = render(<StatusTag status="offline" />)
    expect(container.firstElementChild?.className).not.toContain('bg-')
  })

  it('draws the glyph at the requested size', () => {
    const { container } = render(<StatusTag status="offline" glyphSize={16} />)
    expect(container.querySelector('svg')).toHaveClass('size-4')
  })

  it('never lets the word wrap', () => {
    const { container } = render(<StatusTag status="offline" word="OFFLINE" />)
    expect(container.firstElementChild).toHaveClass('whitespace-nowrap')
  })
})
