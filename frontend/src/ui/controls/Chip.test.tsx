import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { StatusGlyph } from '@/ui/status'
import { Chip } from './Chip'

function Harness({ onChange }: { onChange?: (pressed: boolean) => void }) {
  const [pressed, setPressed] = useState(false)
  return (
    <Chip
      pressed={pressed}
      onPressedChange={(next) => {
        setPressed(next)
        onChange?.(next)
      }}
      count={4}
      leading={<StatusGlyph status="critical" />}
    >
      CRIT
    </Chip>
  )
}

describe('Chip', () => {
  it('is a toggle button whose name is its label and count', () => {
    render(<Harness />)
    const chip = screen.getByRole('button', { name: 'CRIT 4' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(chip).toHaveAttribute('type', 'button')
  })

  it('toggles on click and reports the new state', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const chip = screen.getByRole('button', { name: 'CRIT 4' })
    await userEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(onChange.mock.calls).toEqual([[true], [false]])
  })

  it('toggles from the keyboard with Enter and Space', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')
    expect(onChange.mock.calls).toEqual([[true], [false]])
  })

  it('fills with the primary tint while pressed', () => {
    const { rerender } = render(
      <Chip pressed={false} onPressedChange={() => {}}>
        ALL
      </Chip>,
    )
    expect(screen.getByRole('button', { name: 'ALL' })).not.toHaveClass('bg-primary-tint')
    rerender(
      <Chip pressed onPressedChange={() => {}}>
        ALL
      </Chip>,
    )
    expect(screen.getByRole('button', { name: 'ALL' })).toHaveClass(
      'bg-primary-tint',
      'text-primary',
    )
  })

  it('draws the leading glyph before the label and omits an absent count', () => {
    const { container } = render(
      <Chip pressed={false} onPressedChange={() => {}} leading={<StatusGlyph status="warning" />}>
        WARN
      </Chip>,
    )
    const chip = screen.getByRole('button', { name: 'WARN' })
    expect(chip.firstElementChild).toBe(container.querySelector('svg[data-status="warning"]'))
    expect(chip.querySelectorAll('span')).toHaveLength(1)
  })

  it('does not toggle when disabled', async () => {
    const onChange = vi.fn()
    render(
      <Chip pressed={false} onPressedChange={onChange} disabled>
        ALL
      </Chip>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'ALL' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
