import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

const OPTIONS = [
  { value: 'all', label: 'All customers' },
  { value: 'acme', label: 'Acme' },
  { value: 'globex', label: 'Globex' },
] as const

type Customer = (typeof OPTIONS)[number]['value']

function Harness({
  onChange,
  hideLabel,
  className,
}: {
  onChange?: (value: Customer) => void
  hideLabel?: boolean
  className?: string
}) {
  const [value, setValue] = useState<Customer>('all')
  return (
    <Select
      label="Customer"
      hideLabel={hideLabel}
      className={className}
      value={value}
      options={OPTIONS}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

describe('Select', () => {
  it('is a native select named by its visible label', () => {
    render(<Harness />)
    const select = screen.getByRole('combobox', { name: 'Customer' })
    expect(select.tagName).toBe('SELECT')
    expect(select).toHaveValue('all')
    expect(screen.getByText('Customer')).not.toHaveClass('sr-only')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All customers',
      'Acme',
      'Globex',
    ])
  })

  it('reports the chosen value', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Customer' }), 'Globex')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('globex')
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('globex')
  })

  it('keeps the label as the accessible name when it is visually hidden', () => {
    render(<Harness hideLabel />)
    expect(screen.getByText('Customer')).toHaveClass('sr-only')
    expect(screen.getByLabelText('Customer')).toBe(screen.getByRole('combobox'))
  })

  it('can be changed from the keyboard and disabled', async () => {
    const { rerender } = render(
      <Select label="Site" value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />,
    )
    await userEvent.tab()
    expect(screen.getByRole('combobox', { name: 'Site' })).toHaveFocus()
    rerender(
      <Select
        label="Site"
        value="a"
        options={[{ value: 'a', label: 'A' }]}
        onChange={() => {}}
        disabled
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Site' })).toBeDisabled()
  })

  it('applies className to the whole control so the caller can size it', () => {
    const { container } = render(<Harness className="w-48" />)
    expect(container.firstElementChild).toHaveClass('w-48')
  })
})
