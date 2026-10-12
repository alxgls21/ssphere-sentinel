import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu, type MenuItem } from './Menu'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup() {
  const calls = {
    refresh: vi.fn(),
    shortcuts: vi.fn(),
    singleKey: vi.fn(),
    timezone: vi.fn(),
  }
  function Harness() {
    const [singleKey, setSingleKey] = useState(true)
    const [timezone, setTimezone] = useState('utc')
    const items: MenuItem[] = [
      { type: 'action', label: 'Refresh now', hint: 'r', onSelect: calls.refresh },
      { type: 'action', label: 'Show shortcuts', onSelect: calls.shortcuts },
      { type: 'separator' },
      {
        type: 'checkbox',
        label: 'Single-key shortcuts',
        checked: singleKey,
        onChange: (checked) => {
          setSingleKey(checked)
          calls.singleKey(checked)
        },
      },
      {
        type: 'radio-group',
        label: 'Timezone',
        value: timezone,
        options: [
          { value: 'utc', label: 'UTC' },
          { value: 'local', label: 'Local' },
        ],
        onChange: (value) => {
          setTimezone(value)
          calls.timezone(value)
        },
      },
    ]
    return (
      <>
        <button type="button">before</button>
        <Menu label="Display options" trigger="Display" items={items} />
        <button type="button">after</button>
      </>
    )
  }
  render(<Harness />)
  return {
    calls,
    trigger: screen.getByRole('button', { name: 'Display options' }),
    menu: () => screen.queryByRole('menu'),
    item: (name: string | RegExp) => {
      for (const role of ['menuitem', 'menuitemcheckbox', 'menuitemradio']) {
        const found = screen.queryByRole(role, { name })
        if (found) return found
      }
      throw new Error(`no menu item named ${String(name)}`)
    },
    items: () => [...screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]')],
  }
}

describe('Menu trigger', () => {
  it('is a menu button that reports whether the popup is open', async () => {
    const { trigger, menu } = setup()
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).not.toHaveAttribute('aria-controls')
    expect(menu()).not.toBeInTheDocument()

    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', screen.getByRole('menu').id)
  })

  it('toggles closed when clicked again', async () => {
    const { trigger, menu } = setup()
    await userEvent.click(trigger)
    await userEvent.click(trigger)
    expect(menu()).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens with ArrowDown on the first item and ArrowUp on the last', async () => {
    const { trigger, item } = setup()
    await userEvent.tab()
    await userEvent.tab()
    expect(trigger).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(item(/^Refresh now/)).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(item('Local')).toHaveFocus()
  })

  it('opens with Enter, like any button', async () => {
    const { trigger, item } = setup()
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(item(/^Refresh now/)).toHaveFocus()
  })
})

describe('Menu popup', () => {
  it('is a labelled menu with the right item roles and focus on the first item', async () => {
    const { trigger, item } = setup()
    await userEvent.click(trigger)
    expect(screen.getByRole('menu', { name: 'Display options' })).toBeInTheDocument()
    expect(item(/^Refresh now/)).toHaveAttribute('role', 'menuitem')
    expect(item(/^Refresh now/)).toHaveFocus()
    expect(item('Show shortcuts')).toHaveAttribute('role', 'menuitem')
    expect(item('Single-key shortcuts')).toHaveAttribute('role', 'menuitemcheckbox')
    expect(item('Single-key shortcuts')).toHaveAttribute('aria-checked', 'true')
    expect(item('UTC')).toHaveAttribute('role', 'menuitemradio')
    expect(item('UTC')).toHaveAttribute('aria-checked', 'true')
    expect(item('Local')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('group', { name: 'Timezone' })).toContainElement(item('UTC'))
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('shows an action hint as a keycap', async () => {
    const { trigger, item } = setup()
    await userEvent.click(trigger)
    expect(item(/^Refresh now/).querySelector('kbd')).toHaveTextContent('r')
  })

  it('has exactly one tab stop, on the focused item', async () => {
    const { trigger, items } = setup()
    await userEvent.click(trigger)
    const all = items()
    expect(all).toHaveLength(5)
    expect(all.filter((element) => element.tabIndex === 0)).toEqual([all[0]])
    await userEvent.keyboard('{ArrowDown}')
    expect(all.filter((element) => element.tabIndex === 0)).toEqual([all[1]])
  })

  it('opens without items and still closes with Escape', async () => {
    render(<Menu label="Empty" trigger="Empty" items={[]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Empty' }))
    expect(screen.getByRole('menu', { name: 'Empty' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('renders inside an open dialog so a modal cannot hide or inert it', async () => {
    render(
      <dialog open>
        <Menu
          label="Filters"
          trigger="Filters"
          items={[{ type: 'action', label: 'Reset', onSelect: () => {} }]}
        />
      </dialog>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('menu'))
  })
})

describe('Menu keyboard', () => {
  it('moves with Up and Down and wraps at both ends', async () => {
    const { trigger, item } = setup()
    await userEvent.click(trigger)
    await userEvent.keyboard('{ArrowDown}')
    expect(item('Show shortcuts')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(item('Single-key shortcuts')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(item('Local')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(item(/^Refresh now/)).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(item('Local')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(item('UTC')).toHaveFocus()
  })

  it('jumps to the first and last item with Home and End', async () => {
    const { trigger, item } = setup()
    await userEvent.click(trigger)
    await userEvent.keyboard('{End}')
    expect(item('Local')).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(item(/^Refresh now/)).toHaveFocus()
  })

  it('moves focus to an item by typing the start of its label', async () => {
    const { trigger, item } = setup()
    await userEvent.click(trigger)
    await userEvent.keyboard('si')
    expect(item('Single-key shortcuts')).toHaveFocus()
    await userEvent.keyboard('{Home}')
    await userEvent.keyboard('l')
    expect(item('Local')).toHaveFocus()
  })

  it('cycles through items sharing a first letter when it is repeated', async () => {
    const { trigger, item } = setup()
    await userEvent.click(trigger)
    await userEvent.keyboard('s')
    expect(item('Show shortcuts')).toHaveFocus()
    await userEvent.keyboard('s')
    expect(item('Single-key shortcuts')).toHaveFocus()
    await userEvent.keyboard('s')
    expect(item('Show shortcuts')).toHaveFocus()
  })

  it('starts a new search after a pause in typing', () => {
    vi.useFakeTimers()
    const { trigger, item } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(item(/^Refresh now/), { key: 's' })
    expect(item('Show shortcuts')).toHaveFocus()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // Without the pause this would be the prefix "su", which matches nothing.
    fireEvent.keyDown(item('Show shortcuts'), { key: 'u' })
    expect(item('UTC')).toHaveFocus()
  })

  it('leaves unrelated and modified keys alone', async () => {
    const { trigger, item } = setup()
    await userEvent.click(trigger)
    await userEvent.keyboard('{Control>}s{/Control}')
    expect(item(/^Refresh now/)).toHaveFocus()
    await userEvent.keyboard('z')
    expect(item(/^Refresh now/)).toHaveFocus()
  })
})

describe('Menu closing', () => {
  it('closes on Escape and returns focus to the trigger', async () => {
    const { trigger, menu } = setup()
    await userEvent.click(trigger)
    await userEvent.keyboard('{ArrowDown}{Escape}')
    expect(menu()).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('consumes Escape so a dialog or filter beneath it stays put', async () => {
    const { trigger } = setup()
    const below = vi.fn()
    document.addEventListener('keydown', below)
    await userEvent.click(trigger)
    below.mockClear()
    await userEvent.keyboard('{Escape}')
    expect(below).not.toHaveBeenCalled()
    document.removeEventListener('keydown', below)
  })

  it('closes on an outside click without taking focus back from what was clicked', async () => {
    const { trigger, menu } = setup()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('button', { name: 'after' }))
    expect(menu()).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
  })

  it('stays open for a click inside the popup that hits no item', async () => {
    const { trigger, menu } = setup()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menu'))
    expect(menu()).toBeInTheDocument()
  })

  it('closes on Tab with focus already on the trigger, so Tab carries on from there', async () => {
    const { trigger, menu, item } = setup()
    await userEvent.click(trigger)
    fireEvent.keyDown(item(/^Refresh now/), { key: 'Tab' })
    expect(menu()).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

describe('Menu items', () => {
  it('runs an action, closes, and returns focus to the trigger', async () => {
    const { trigger, menu, item, calls } = setup()
    await userEvent.click(trigger)
    await userEvent.click(item('Show shortcuts'))
    expect(calls.shortcuts).toHaveBeenCalledOnce()
    expect(menu()).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('activates the focused action with Enter and with Space', async () => {
    const { trigger, calls } = setup()
    await userEvent.click(trigger)
    await userEvent.keyboard('{Enter}')
    expect(calls.refresh).toHaveBeenCalledOnce()
    await userEvent.click(trigger)
    await userEvent.keyboard(' ')
    expect(calls.refresh).toHaveBeenCalledTimes(2)
  })

  it('lets an action that moves focus keep it', async () => {
    render(
      <>
        <input aria-label="Name" />
        <Menu
          label="Edit menu"
          trigger="Edit"
          items={[
            {
              type: 'action',
              label: 'Rename',
              onSelect: () => screen.getByRole('textbox', { name: 'Name' }).focus(),
            },
          ]}
        />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Edit menu' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  })

  it('toggles a checkbox and keeps the menu open on the same item', async () => {
    const { trigger, menu, item, calls } = setup()
    await userEvent.click(trigger)
    await userEvent.click(item('Single-key shortcuts'))
    expect(calls.singleKey).toHaveBeenLastCalledWith(false)
    expect(menu()).toBeInTheDocument()
    expect(item('Single-key shortcuts')).toHaveAttribute('aria-checked', 'false')
    expect(item('Single-key shortcuts')).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(calls.singleKey).toHaveBeenLastCalledWith(true)
    expect(item('Single-key shortcuts')).toHaveAttribute('aria-checked', 'true')
  })

  it('chooses a radio option and keeps the menu open', async () => {
    const { trigger, menu, item, calls } = setup()
    await userEvent.click(trigger)
    await userEvent.click(item('Local'))
    expect(calls.timezone).toHaveBeenCalledExactlyOnceWith('local')
    expect(menu()).toBeInTheDocument()
    expect(item('Local')).toHaveAttribute('aria-checked', 'true')
    expect(item('UTC')).toHaveAttribute('aria-checked', 'false')
  })
})

describe('Menu placement', () => {
  it('opens below the trigger with the right edges aligned', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'menu'
        ? new DOMRect(0, 0, 200, 150)
        : new DOMRect(900, 8, 60, 28)
    })
    const { trigger } = setup()
    await userEvent.click(trigger)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('760px')
    expect(menu.style.top).toBe('40px')
  })
})
