import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FeatureChip, PlannedChip } from './Chips'

describe('FeatureChip', () => {
  it.each([
    ['planned', 'Planned'],
    ['needs-configuration', 'Needs setup'],
    ['not-connected', 'Not connected'],
    ['unknown', 'Unknown'],
  ] as const)(
    'says %s in words, with a dashed outline and the planned ring',
    (availability, word) => {
      const { container } = render(<FeatureChip availability={availability} title="why" />)
      const chip = screen.getByText(word)
      expect(chip).toHaveAttribute('title', 'why')
      expect(chip).toHaveClass('border-dashed')
      expect(container.querySelector('svg[data-status="planned"]')).not.toBeNull()
    },
  )

  it('uses the short words for a header with little room, keeping the reason in the title', () => {
    render(
      <>
        <FeatureChip availability="needs-configuration" compact title="a" />
        <FeatureChip availability="not-connected" compact title="b" />
        <FeatureChip availability="planned" compact title="c" />
      </>,
    )
    expect(screen.getByText('Setup')).toHaveAttribute('title', 'a')
    expect(screen.getByText('Demo')).toHaveAttribute('title', 'b')
    expect(screen.getByText('Planned')).toHaveAttribute('title', 'c')
  })

  it('keeps the PLANNED chip for what the backend does not implement, with its own default reason', () => {
    render(<PlannedChip />)
    expect(screen.getByText('Planned')).toHaveAttribute(
      'title',
      'Not implemented in the backend yet. Sample data.',
    )
  })
})
