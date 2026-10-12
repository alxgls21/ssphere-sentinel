import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PanelLeftClose } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IconButton } from './IconButton'
import { stubFocusVisible } from './testing'

beforeEach(() => stubFocusVisible())
afterEach(() => vi.restoreAllMocks())

describe('IconButton', () => {
  it('is named by its aria-label and draws a decorative 16px icon', () => {
    const { container } = render(<IconButton aria-label="Collapse sidebar" icon={PanelLeftClose} />)
    const button = screen.getByRole('button', { name: 'Collapse sidebar' })
    expect(button).toHaveAttribute('type', 'button')
    const icon = container.querySelector('svg')
    expect(icon).toHaveAttribute('width', '16')
    expect(icon).toHaveAttribute('stroke-width', '1.5')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('requires an accessible name in its prop type', () => {
    // @ts-expect-error aria-label is required: an icon-only button has no other name.
    render(<IconButton icon={PanelLeftClose} />)
  })

  it('lists the shortcut in its tooltip on keyboard focus and describes the button with it', async () => {
    render(<IconButton aria-label="Collapse sidebar" shortcut="[" icon={PanelLeftClose} />)
    await userEvent.tab()
    const button = screen.getByRole('button', { name: 'Collapse sidebar' })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Collapse sidebar ([)')
    expect(button).toHaveAccessibleDescription('Collapse sidebar ([)')
  })

  it('shows just the name when there is no shortcut', async () => {
    render(<IconButton aria-label="Refresh" icon={PanelLeftClose} />)
    await userEvent.tab()
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Refresh$/)
  })

  it('clicks like a button and passes props through', async () => {
    const onClick = vi.fn()
    render(
      <IconButton
        aria-label="Pause updates"
        aria-pressed="false"
        icon={PanelLeftClose}
        onClick={onClick}
        variant="ghost"
      />,
    )
    const button = screen.getByRole('button', { name: 'Pause updates' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })
})
