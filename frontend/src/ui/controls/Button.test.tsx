import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('is a plain button by default so it never submits a surrounding form', async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button>Apply</Button>
        <Button type="submit">Save</Button>
      </form>,
    )
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveAttribute('type', 'button')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('does nothing and leaves the tab order when disabled', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Refresh
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Refresh' })
    await userEvent.click(button)
    await userEvent.tab()
    expect(onClick).not.toHaveBeenCalled()
    expect(button).not.toHaveFocus()
  })

  it('stays focusable and clickable with aria-disabled so it can explain itself', async () => {
    const onClick = vi.fn()
    render(
      <Button aria-disabled="true" onClick={onClick}>
        Acknowledge
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Acknowledge' })
    await userEvent.tab()
    expect(button).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('has a compact 24px size for panel headers and banners', () => {
    render(
      <>
        <Button>Retry</Button>
        <Button size="sm">Dismiss</Button>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveClass('h-(--ctl-h)')
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveClass('h-6')
    expect(screen.getByRole('button', { name: 'Dismiss' })).not.toHaveClass('h-(--ctl-h)')
  })

  it('forwards a ref and extra classes to the button', () => {
    const ref = { current: null as HTMLButtonElement | null }
    render(
      <Button ref={ref} variant="primary" className="w-full">
        Go
      </Button>,
    )
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Go' }))
    expect(ref.current).toHaveClass('w-full', 'bg-primary')
  })
})
