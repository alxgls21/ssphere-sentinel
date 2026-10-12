import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaQuery } from './useMediaQuery'

type Listener = () => void

function stubMatchMedia(initial: boolean) {
  let matches = initial
  const listeners = new Set<Listener>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matches
    },
    media: query,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  }))
  return (next: boolean) => {
    matches = next
    listeners.forEach((l) => l())
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('useMediaQuery', () => {
  it('reads the current match and follows changes', () => {
    const set = stubMatchMedia(false)
    const { result } = renderHook(() => useMediaQuery('(min-width: 64rem)'))
    expect(result.current).toBe(false)
    act(() => set(true))
    expect(result.current).toBe(true)
  })
})
