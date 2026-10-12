import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubFocusVisible } from './testing'
import { Tooltip } from './Tooltip'

beforeEach(() => stubFocusVisible())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function renderTooltip(content: ReactNode = 'Latest probe') {
  render(
    <>
      <Tooltip content={content}>
        <button type="button">Probe</button>
      </Tooltip>
      <button type="button">Other</button>
    </>,
  )
  return screen.getByRole('button', { name: 'Probe' })
}

describe('Tooltip on keyboard focus', () => {
  it('opens immediately and describes the trigger while open', async () => {
    const trigger = renderTooltip()
    await userEvent.tab()
    expect(trigger).toHaveFocus()
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Latest probe')
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
    expect(trigger).toHaveAccessibleDescription('Latest probe')
  })

  it('does not open for a click that merely focuses the trigger', async () => {
    stubFocusVisible(false)
    const trigger = renderTooltip()
    await userEvent.click(trigger)
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes on blur', async () => {
    const trigger = renderTooltip()
    await userEvent.tab()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    await userEvent.tab()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(trigger).not.toHaveAttribute('aria-describedby')
  })

  it('closes on Escape and consumes it so nothing underneath also reacts', async () => {
    const trigger = renderTooltip()
    const seen: string[] = []
    const below = (event: KeyboardEvent) => seen.push(event.key)
    document.addEventListener('keydown', below)
    await userEvent.tab()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(seen).not.toContain('Escape')

    // With no tooltip open Escape passes through untouched.
    await userEvent.keyboard('{Escape}')
    expect(seen).toContain('Escape')
    document.removeEventListener('keydown', below)
  })

  it('renders only the trigger when there is no content', async () => {
    const trigger = renderTooltip(null)
    await userEvent.tab()
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(trigger).not.toHaveAttribute('aria-describedby')
  })

  it('does not come back stale after its content was withdrawn while open', async () => {
    const tooltip = (content: string | null) => (
      <Tooltip content={content}>
        <button type="button">Probe</button>
      </Tooltip>
    )
    const { rerender } = render(tooltip('Rail label'))
    await userEvent.tab()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    rerender(tooltip(null))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    rerender(tooltip('Rail label'))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps the very same trigger, and its focus, when content comes and goes', async () => {
    const tooltip = (content: string | null) => (
      <Tooltip content={content}>
        <button type="button">Probe</button>
      </Tooltip>
    )
    const { rerender } = render(tooltip(null))
    await userEvent.tab()
    const trigger = screen.getByRole('button', { name: 'Probe' })
    expect(trigger).toHaveFocus()
    rerender(tooltip('Rail label'))
    expect(screen.getByRole('button', { name: 'Probe' })).toBe(trigger)
    expect(trigger).toHaveFocus()
    rerender(tooltip(null))
    expect(screen.getByRole('button', { name: 'Probe' })).toBe(trigger)
    expect(trigger).toHaveFocus()
  })

  it('keeps the trigger own handlers and aria-describedby', async () => {
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    render(
      <Tooltip content="Latest probe">
        <button type="button" aria-describedby="hint" onFocus={onFocus} onBlur={onBlur}>
          Probe
        </button>
      </Tooltip>,
    )
    const trigger = screen.getByRole('button', { name: 'Probe' })
    expect(trigger).toHaveAttribute('aria-describedby', 'hint')
    await userEvent.tab()
    expect(onFocus).toHaveBeenCalledOnce()
    expect(trigger).toHaveAttribute('aria-describedby', `hint ${screen.getByRole('tooltip').id}`)
    await userEvent.tab()
    expect(onBlur).toHaveBeenCalledOnce()
    expect(trigger).toHaveAttribute('aria-describedby', 'hint')
  })

  it('renders inside an open dialog so a modal cannot hide it behind the top layer', async () => {
    render(
      <dialog open>
        <Tooltip content="Close the sheet">
          <button type="button">x</button>
        </Tooltip>
      </dialog>,
    )
    await userEvent.tab()
    expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('tooltip'))
  })

  it('renders in the body, clear of the trigger container, when there is no dialog', async () => {
    const trigger = renderTooltip()
    await userEvent.tab()
    expect(trigger.parentElement).not.toContainElement(screen.getByRole('tooltip'))
    expect(document.body).toContainElement(screen.getByRole('tooltip'))
  })
})

describe('Tooltip on pointer hover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  const enter = (element: HTMLElement) => fireEvent.pointerEnter(element, { pointerType: 'mouse' })
  const leave = (element: HTMLElement) => fireEvent.pointerLeave(element, { pointerType: 'mouse' })

  it('opens after 300 ms and not a moment sooner', () => {
    const trigger = renderTooltip()
    enter(trigger)
    advance(299)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    advance(1)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Latest probe')
    expect(trigger).toHaveAccessibleDescription('Latest probe')
  })

  it('never opens on touch hover but does for a pen', () => {
    const trigger = renderTooltip()
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' })
    advance(1000)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.pointerEnter(trigger, { pointerType: 'pen' })
    advance(300)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('cancels a pending open when the pointer leaves first', () => {
    const trigger = renderTooltip()
    enter(trigger)
    advance(200)
    leave(trigger)
    advance(500)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes 100 ms after the pointer leaves', () => {
    const trigger = renderTooltip()
    enter(trigger)
    advance(300)
    leave(trigger)
    advance(99)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('stays open while the pointer is on the tooltip itself, and closes when it leaves', () => {
    const trigger = renderTooltip()
    enter(trigger)
    advance(300)
    leave(trigger)
    enter(screen.getByRole('tooltip'))
    advance(1000)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    leave(screen.getByRole('tooltip'))
    advance(100)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('stays open while keyboard focus remains, even after the pointer passes over', () => {
    const trigger = renderTooltip()
    act(() => trigger.focus())
    enter(trigger)
    leave(trigger)
    advance(500)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('closes when the trigger is pressed, so it never covers what the press opens', () => {
    const trigger = renderTooltip()
    enter(trigger)
    advance(300)
    fireEvent.pointerDown(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes on Escape while only hovered', () => {
    const trigger = renderTooltip()
    enter(trigger)
    advance(300)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('Tooltip placement', () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    new DOMRect(left, top, width, height)

  function measure(trigger: DOMRect) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'tooltip' ? rect(0, 0, 100, 20) : trigger
    })
  }

  it('sits centered above the trigger', async () => {
    measure(rect(200, 100, 40, 28))
    renderTooltip()
    await userEvent.tab()
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.style.left).toBe('170px')
    expect(tooltip.style.top).toBe('74px')
  })

  it('flips below the trigger when there is no room above', async () => {
    measure(rect(200, 10, 40, 28))
    renderTooltip()
    await userEvent.tab()
    expect(screen.getByRole('tooltip').style.top).toBe('44px')
  })
})
