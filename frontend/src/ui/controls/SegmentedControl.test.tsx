import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SegmentedControl, type SegmentedControlProps } from './SegmentedControl'
import { stubFocusVisible } from './testing'

beforeEach(() => stubFocusVisible())
afterEach(() => vi.restoreAllMocks())

const OPTIONS = [
  { value: 'cpu', label: 'CPU', title: 'Processor load' },
  { value: 'ram', label: 'RAM' },
  { value: 'disk', label: 'DISK' },
] as const

type Metric = (typeof OPTIONS)[number]['value']

function Harness({
  initial = 'cpu',
  onChange,
  ...props
}: {
  initial?: Metric
  onChange?: (value: Metric) => void
} & Partial<Pick<SegmentedControlProps<Metric>, 'variant' | 'size'>>) {
  const [value, setValue] = useState<Metric>(initial)
  return (
    <>
      <button type="button">before</button>
      <SegmentedControl
        aria-label="Metric"
        value={value}
        options={OPTIONS}
        onChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
        {...props}
      />
      <button type="button">after</button>
    </>
  )
}

describe.each([
  ['radio', 'radiogroup', 'radio', 'aria-checked'],
  ['tabs', 'tablist', 'tab', 'aria-selected'],
] as const)('SegmentedControl variant=%s', (variant, groupRole, itemRole, selectedAttr) => {
  const segment = (name: string) => screen.getByRole(itemRole, { name })

  it('exposes the group and the selected segment', () => {
    render(<Harness variant={variant} initial="ram" />)
    expect(screen.getByRole(groupRole, { name: 'Metric' })).toBeInTheDocument()
    expect(screen.getAllByRole(itemRole)).toHaveLength(3)
    expect(segment('RAM')).toHaveAttribute(selectedAttr, 'true')
    expect(segment('CPU')).toHaveAttribute(selectedAttr, 'false')
    expect(segment('DISK')).toHaveAttribute(selectedAttr, 'false')
  })

  it('is a single tab stop that rests on the selected segment', async () => {
    render(<Harness variant={variant} initial="ram" />)
    expect(segment('RAM')).toHaveAttribute('tabindex', '0')
    expect(segment('CPU')).toHaveAttribute('tabindex', '-1')
    await userEvent.tab()
    await userEvent.tab()
    expect(segment('RAM')).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
  })

  it('moves focus and selection together with the arrow keys, wrapping at the ends', async () => {
    const onChange = vi.fn()
    render(<Harness variant={variant} onChange={onChange} />)
    await userEvent.tab()
    await userEvent.tab()
    expect(segment('CPU')).toHaveFocus()

    await userEvent.keyboard('{ArrowRight}')
    expect(segment('RAM')).toHaveFocus()
    expect(segment('RAM')).toHaveAttribute(selectedAttr, 'true')

    await userEvent.keyboard('{ArrowDown}{ArrowRight}')
    expect(segment('CPU')).toHaveFocus()
    expect(segment('CPU')).toHaveAttribute(selectedAttr, 'true')

    await userEvent.keyboard('{ArrowLeft}')
    expect(segment('DISK')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(segment('RAM')).toHaveFocus()
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      'ram',
      'disk',
      'cpu',
      'disk',
      'ram',
    ])
  })

  it('jumps to the first and last segment with Home and End', async () => {
    render(<Harness variant={variant} initial="ram" />)
    await userEvent.tab()
    await userEvent.tab()
    await userEvent.keyboard('{End}')
    expect(segment('DISK')).toHaveFocus()
    expect(segment('DISK')).toHaveAttribute(selectedAttr, 'true')
    await userEvent.keyboard('{Home}')
    expect(segment('CPU')).toHaveFocus()
    expect(segment('CPU')).toHaveAttribute(selectedAttr, 'true')
  })

  it('selects on click, and clicking the selected segment changes nothing', async () => {
    const onChange = vi.fn()
    render(<Harness variant={variant} onChange={onChange} />)
    await userEvent.click(segment('DISK'))
    expect(segment('DISK')).toHaveAttribute(selectedAttr, 'true')
    await userEvent.click(segment('DISK'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('disk')
  })

  it('moves the single tab stop with the selection', async () => {
    render(<Harness variant={variant} />)
    await userEvent.click(segment('DISK'))
    expect(segment('DISK')).toHaveAttribute('tabindex', '0')
    expect(segment('CPU')).toHaveAttribute('tabindex', '-1')
  })
})

describe('SegmentedControl', () => {
  it('uses radio semantics by default and sizes to the control height', () => {
    render(<Harness />)
    const group = screen.getByRole('radiogroup', { name: 'Metric' })
    expect(group).toHaveClass('h-(--ctl-h)')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('has a compact 24px size for panel headers', () => {
    render(<Harness size="sm" />)
    expect(screen.getByRole('radiogroup', { name: 'Metric' })).toHaveClass('h-6')
  })

  it('keeps the first segment reachable when the value matches no option', async () => {
    render(
      <SegmentedControl
        aria-label="Metric"
        value={'gpu' as Metric}
        options={OPTIONS}
        onChange={() => {}}
      />,
    )
    await userEvent.tab()
    expect(screen.getByRole('radio', { name: 'CPU' })).toHaveFocus()
  })

  it('shows an option title as a tooltip on keyboard focus, as a supplement to the label', async () => {
    render(<Harness />)
    await userEvent.tab()
    await userEvent.tab()
    const cpu = screen.getByRole('radio', { name: 'CPU' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Processor load')
    expect(cpu).toHaveAccessibleDescription('Processor load')
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
