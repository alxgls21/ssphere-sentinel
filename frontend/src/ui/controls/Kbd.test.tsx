import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kbd, ModKbd } from './Kbd'

afterEach(() => vi.unstubAllGlobals())

describe('Kbd', () => {
  it('renders its keys in a <kbd> element', () => {
    const { container } = render(<Kbd>Esc</Kbd>)
    const keycap = container.querySelector('kbd')
    expect(keycap).toHaveTextContent('Esc')
    expect(keycap).toHaveClass('border-border-strong', 'bg-raised')
  })

  it('passes through aria-hidden for keycaps that only repeat a shortcut', () => {
    const { container } = render(<Kbd aria-hidden="true">[</Kbd>)
    expect(container.querySelector('kbd')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('ModKbd', () => {
  it('shows the Command symbol on macOS and still names the key for screen readers', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' } })
    render(<ModKbd />)
    expect(screen.getByText('⌘')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('Command')).toHaveClass('sr-only')
  })

  it('shows Ctrl everywhere else', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' } })
    const { container } = render(<ModKbd />)
    expect(container.querySelector('kbd')).toHaveTextContent('Ctrl')
    expect(screen.queryByText('Command')).not.toBeInTheDocument()
  })
})
