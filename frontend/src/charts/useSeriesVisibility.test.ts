import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isolateHidden, toggleHidden, useSeriesVisibility } from './useSeriesVisibility'

const IDS = ['a', 'b', 'c'] as const

describe('series visibility', () => {
  it('starts with every series visible', () => {
    const { result } = renderHook(() => useSeriesVisibility(IDS))
    expect(result.current.hidden.size).toBe(0)
  })

  it('toggles one series off and on without touching the others', () => {
    const { result } = renderHook(() => useSeriesVisibility(IDS))
    act(() => result.current.toggle('b'))
    expect([...result.current.hidden]).toEqual(['b'])
    act(() => result.current.toggle('b'))
    expect(result.current.hidden.size).toBe(0)
  })

  it('shows everything again when the last visible series is hidden', () => {
    expect([...toggleHidden(new Set(['a', 'b']), 'c', IDS)]).toEqual([])
  })

  it('isolates one series, and restores all when it is isolated already', () => {
    const { result } = renderHook(() => useSeriesVisibility(IDS))
    act(() => result.current.isolate('b'))
    expect([...result.current.hidden].sort()).toEqual(['a', 'c'])
    act(() => result.current.isolate('b'))
    expect(result.current.hidden.size).toBe(0)
  })

  it('isolating a different series switches the focus to it', () => {
    expect([...isolateHidden(new Set(['a', 'c']), 'c', IDS)].sort()).toEqual(['a', 'b'])
  })

  it('keeps a stable object while nothing changes', () => {
    const { result, rerender } = renderHook(() => useSeriesVisibility(IDS))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
