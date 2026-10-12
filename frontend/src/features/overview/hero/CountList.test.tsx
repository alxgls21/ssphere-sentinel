import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CountList } from './CountList'
import { counts } from './testing'

describe('CountList', () => {
  it('lists glyph, number and word for statuses with members, worst first', () => {
    const { container } = render(
      <CountList
        counts={counts({ healthy: 112, warning: 5, critical: 4, unknown: 2 })}
        show={['healthy', 'unknown', 'warning', 'critical']}
      />,
    )
    expect(container).toHaveTextContent('4 CRIT5 WARN2 UNKN112 OK')
    expect([...container.querySelectorAll('svg')].map((svg) => svg.dataset.status)).toEqual([
      'critical',
      'warning',
      'unknown',
      'healthy',
    ])
  })

  it('lists only the statuses it is asked to show', () => {
    const { container } = render(
      <CountList counts={counts({ healthy: 9, idle: 3, critical: 1 })} show={['critical']} />,
    )
    expect(container).toHaveTextContent('1 CRIT')
    expect(container).not.toHaveTextContent('OK')
    expect(container).not.toHaveTextContent('IDLE')
  })

  it('keeps shape and number but drops the words on request', () => {
    const { container } = render(
      <CountList
        counts={counts({ warning: 2, critical: 1 })}
        show={['critical', 'warning']}
        words={false}
      />,
    )
    expect(container).toHaveTextContent('12')
    expect(container).not.toHaveTextContent('CRIT')
    expect(container.querySelectorAll('svg')).toHaveLength(2)
  })

  it('shows the empty text, or just keeps its height, when there is nothing to list', () => {
    const { container, rerender } = render(
      <CountList counts={counts({ healthy: 3 })} show={['critical']} empty="none" />,
    )
    expect(container).toHaveTextContent('none')
    rerender(<CountList counts={counts({ healthy: 3 })} show={['critical']} />)
    expect(container).toHaveTextContent('')
    expect(container.firstElementChild).toHaveClass('min-h-4')
  })

  it('separates the number from its word for copied and spoken text', () => {
    const { container } = render(<CountList counts={counts({ critical: 4 })} show={['critical']} />)
    expect(container.textContent).toBe('4 CRIT')
  })
})
