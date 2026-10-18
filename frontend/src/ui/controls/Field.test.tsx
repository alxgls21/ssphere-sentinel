import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Checkbox, FieldInput, FieldSelect, FieldTextArea, RadioGroup, type RadioChoice } from '.'

describe('FieldInput', () => {
  function Harness({ error, onChange }: { error?: string[]; onChange?: (value: string) => void }) {
    const [value, setValue] = useState('')
    return (
      <FieldInput
        label="Name"
        hint="Shown in the list."
        error={error}
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
      />
    )
  }

  it('is labelled by a real label, and typing reports the value', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(screen.getByLabelText('Name'), 'ab')
    expect(onChange).toHaveBeenLastCalledWith('ab')
    expect(screen.getByLabelText('Name')).toHaveValue('ab')
  })

  it('names its hint as the description, and is not invalid without an error', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Name')
    expect(input).toHaveAccessibleDescription('Shown in the list.')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('says every error in words as well as colour, and describes the field with them', () => {
    render(<Harness error={['Taken.', 'Too long.']} />)
    const input = screen.getByLabelText('Name')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(
      /Shown in the list\..*Error:\s*Taken\..*Error:\s*Too long\./,
    )
    const errors = screen.getAllByRole('listitem')
    expect(errors).toHaveLength(2)
    expect(errors[0]).toHaveTextContent('Error: Taken.')
  })

  it('takes a single error as text, and passes the input attributes on', () => {
    render(
      <FieldInput
        label="Delay"
        value="5"
        onChange={() => {}}
        error="Enter a number."
        input={{ inputMode: 'numeric', disabled: true }}
      />,
    )
    const input = screen.getByLabelText('Delay')
    expect(input).toHaveAttribute('inputmode', 'numeric')
    expect(input).toBeDisabled()
    expect(screen.getByText('Enter a number.')).toBeInTheDocument()
  })

  it('gives two fields their own ids', () => {
    render(
      <>
        <FieldInput label="A" value="" onChange={() => {}} />
        <FieldInput label="B" value="" onChange={() => {}} />
      </>,
    )
    expect(screen.getByLabelText('A').id).not.toBe(screen.getByLabelText('B').id)
  })
})

describe('FieldTextArea', () => {
  it('is a labelled multi-line field that reports what is typed', async () => {
    const onChange = vi.fn()
    function Harness() {
      const [value, setValue] = useState('')
      return (
        <FieldTextArea
          label="Description"
          value={value}
          onChange={(next) => {
            setValue(next)
            onChange(next)
          }}
        />
      )
    }
    render(<Harness />)
    const area = screen.getByLabelText('Description')
    expect(area.tagName).toBe('TEXTAREA')
    await userEvent.type(area, 'hi')
    expect(onChange).toHaveBeenLastCalledWith('hi')
  })
})

describe('FieldSelect', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ] as const

  it('is a native select with its label, and reports the chosen value', async () => {
    const onChange = vi.fn()
    render(<FieldSelect label="Kind" value="a" options={options} onChange={onChange} />)
    const select = screen.getByLabelText('Kind')
    expect(select.tagName).toBe('SELECT')
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Alpha', 'Beta'])
    await userEvent.selectOptions(select, 'b')
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('can be disabled, and marks an invalid choice', () => {
    render(
      <FieldSelect
        label="Kind"
        value="a"
        options={options}
        onChange={() => {}}
        disabled
        error="Choose one."
      />,
    )
    expect(screen.getByLabelText('Kind')).toBeDisabled()
    expect(screen.getByLabelText('Kind')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('Checkbox', () => {
  it('is a labelled checkbox that reports its new state', async () => {
    const onChange = vi.fn()
    function Harness() {
      const [checked, setChecked] = useState(false)
      return (
        <Checkbox
          label="Email me"
          description="On every incident."
          checked={checked}
          onChange={(next) => {
            setChecked(next)
            onChange(next)
          }}
        />
      )
    }
    render(<Harness />)
    const box = screen.getByRole('checkbox', { name: 'Email me' })
    expect(box).toHaveAccessibleDescription('On every incident.')
    await userEvent.click(box)
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(box).toBeChecked()
    await userEvent.click(screen.getByText('Email me'))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('does not change while disabled, and says its errors in words', async () => {
    const onChange = vi.fn()
    render(
      <Checkbox
        label="Enabled"
        checked={false}
        onChange={onChange}
        disabled
        error={['Needs an address.']}
      />,
    )
    const box = screen.getByRole('checkbox', { name: 'Enabled' })
    expect(box).toBeDisabled()
    await userEvent.click(box)
    expect(onChange).not.toHaveBeenCalled()
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(box).toHaveAccessibleDescription(/Error:\s*Needs an address\./)
  })
})

describe('RadioGroup', () => {
  const choices: RadioChoice<'a' | 'b'>[] = [
    { value: 'a', label: 'Alpha', hint: 'The first.' },
    { value: 'b', label: 'Beta' },
  ]

  function Harness({ error, disabled }: { error?: string[]; disabled?: boolean }) {
    const [value, setValue] = useState<'a' | 'b'>('a')
    return (
      <RadioGroup
        legend="Letter"
        name="letter"
        value={value}
        onChange={setValue}
        choices={choices}
        error={error}
        disabled={disabled}
      />
    )
  }

  it('is a group named by its legend, each radio named by its own label', () => {
    render(<Harness />)
    const group = screen.getByRole('group', { name: 'Letter' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('name')),
    ).toEqual(['letter', 'letter'])
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Beta' })).not.toBeChecked()
  })

  it('describes a choice by its hint', () => {
    render(<Harness />)
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAccessibleDescription('The first.')
    expect(screen.getByRole('radio', { name: 'Beta' })).not.toHaveAccessibleDescription()
  })

  it('chooses by a click on the radio or its label, and by the arrow keys', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Beta'))
    expect(screen.getByRole('radio', { name: 'Beta' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Alpha' }))
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeChecked()
    screen.getByRole('radio', { name: 'Alpha' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Beta' })).toBeChecked()
  })

  it('says the errors of the set in words, and describes each radio with them', () => {
    render(<Harness error={['Choose one.']} />)
    expect(screen.getByText('Choose one.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAccessibleDescription(
      /Error:\s*Choose one\./,
    )
  })

  it('cannot be changed while disabled', async () => {
    const user = userEvent.setup()
    render(<Harness disabled />)
    expect(screen.getByRole('group', { name: 'Letter' })).toBeDisabled()
    await user.click(screen.getByText('Beta'))
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeChecked()
  })
})
