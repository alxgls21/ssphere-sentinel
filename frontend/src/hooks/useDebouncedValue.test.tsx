import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedValue } from './useDebouncedValue'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useDebouncedValue', () => {
  it('starts at the value it is given', () => {
    expect(renderHook(() => useDebouncedValue('a', 250)).result.current).toBe('a')
  })

  it('follows the input only once it has held still for the delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    })
    rerender({ value: 'ab' })
    act(() => void vi.advanceTimersByTime(200))
    expect(result.current).toBe('a')
    act(() => void vi.advanceTimersByTime(60))
    expect(result.current).toBe('ab')
  })

  it('starts the wait again with every change, so a burst of keys is one answer', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    })
    for (const value of ['ab', 'abc', 'abcd']) {
      rerender({ value })
      act(() => void vi.advanceTimersByTime(200))
    }
    expect(result.current).toBe('a')
    act(() => void vi.advanceTimersByTime(60))
    expect(result.current).toBe('abcd')
  })
})
