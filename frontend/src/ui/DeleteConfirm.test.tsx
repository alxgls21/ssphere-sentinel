import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DeleteConfirm } from './DeleteConfirm'

function setup(over: Partial<React.ComponentProps<typeof DeleteConfirm>> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <DeleteConfirm
      kind="customer"
      name="Meridian"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    >
      <p>Its grants go with it.</p>
    </DeleteConfirm>,
  )
  return { onConfirm, onCancel }
}

const confirm = () => screen.getByRole('button', { name: 'Delete customer' })
const field = () => screen.getByLabelText('Type the customer’s name to confirm')

describe('DeleteConfirm', () => {
  it('is an alert dialog that names the object, says what goes with it, and focuses Cancel first', () => {
    setup()
    expect(
      screen.getByRole('alertdialog', { name: 'Delete the customer “Meridian”?' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Its grants go with it.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('does nothing until the name is typed back exactly', async () => {
    const user = userEvent.setup()
    const { onConfirm } = setup()
    expect(confirm()).toBeDisabled()
    await user.type(field(), 'meridian')
    expect(confirm()).toBeDisabled()
    await user.clear(field())
    await user.type(field(), ' Meridian ')
    expect(confirm()).toBeEnabled()
    await user.click(confirm())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancels with the button and with Escape', async () => {
    const user = userEvent.setup()
    const { onCancel, onConfirm } = setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    await user.click(field())
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('shows why the server refused, and waits while busy', () => {
    setup({ problem: 'The customer “Meridian” still has 2 sites.', busy: true })
    expect(screen.getByRole('alert')).toHaveTextContent('still has 2 sites')
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })
})
