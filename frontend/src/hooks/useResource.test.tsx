import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useResource } from './useResource'

afterEach(() => {
  vi.useRealTimers()
})

describe('useResource', () => {
  it('goes loading -> success', async () => {
    const { result } = renderHook(() => useResource('k', async () => 42))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.data).toBe(42)
    expect(result.current.updatedAt).not.toBeNull()
    expect(result.current.isRefreshing).toBe(false)
  })

  it('reports an error when the first load fails', async () => {
    const { result } = renderHook(() =>
      useResource('k', async () => {
        throw new Error('boom')
      }),
    )
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error?.message).toBe('boom')
    expect(result.current.data).toBeUndefined()
  })

  it('keeps stale data when a refresh fails, and recovers on refetch', async () => {
    let calls = 0
    const { result } = renderHook(() =>
      useResource('k', async () => {
        calls += 1
        if (calls === 2) throw new Error('flaky')
        return calls
      }),
    )
    await waitFor(() => expect(result.current.data).toBe(1))
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.error?.message).toBe('flaky'))
    expect(result.current.status).toBe('success')
    expect(result.current.data).toBe(1)
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.data).toBe(3))
    expect(result.current.error).toBeNull()
  })

  it('shows the loading state again while an explicit retry of a failed first load runs', async () => {
    let attempt = 0
    let release: (value: string) => void = () => {}
    const { result } = renderHook(() =>
      useResource('k', () => {
        attempt += 1
        if (attempt === 1) return Promise.reject(new Error('down'))
        return new Promise<string>((resolve) => (release = resolve))
      }),
    )
    await waitFor(() => expect(result.current.status).toBe('error'))
    act(() => result.current.refetch())
    // The error must not sit there while the retry runs: the operator has to see it is trying.
    await waitFor(() => expect(result.current.status).toBe('loading'))
    expect(result.current.error).toBeNull()
    act(() => release('ok'))
    await waitFor(() => expect(result.current.data).toBe('ok'))
  })

  it('reloads when the key changes, optionally keeping previous data', async () => {
    const { result, rerender } = renderHook(
      ({ range }) =>
        useResource(range, async () => range.toUpperCase(), { keepPreviousData: true }),
      { initialProps: { range: 'a' } },
    )
    await waitFor(() => expect(result.current.data).toBe('A'))
    rerender({ range: 'b' })
    expect(result.current.data).toBe('A')
    expect(result.current.isRefreshing).toBe(true)
    await waitFor(() => expect(result.current.data).toBe('B'))
    expect(result.current.isRefreshing).toBe(false)
  })

  it('drops previous data on a key change by default', async () => {
    const { result, rerender } = renderHook(({ k }) => useResource(k, async () => k), {
      initialProps: { k: 'a' },
    })
    await waitFor(() => expect(result.current.data).toBe('a'))
    rerender({ k: 'b' })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.data).toBe('b'))
  })

  it('polls at the refresh interval and stops on unmount', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => 1)
    const { unmount } = renderHook(() => useResource('k', fetcher, { refreshMs: 1000 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3)
    unmount()
    const calls = fetcher.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(fetcher).toHaveBeenCalledTimes(calls)
  })

  describe('hidden tabs', () => {
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    afterEach(() => setHidden(false))

    it('stops polling while hidden by default', async () => {
      vi.useFakeTimers()
      setHidden(true)
      const fetcher = vi.fn(async () => 1)
      renderHook(() => useResource('k', fetcher, { refreshMs: 1000 }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('keeps polling at the slower hidden rate when asked, so a background tab stays true', async () => {
      vi.useFakeTimers()
      setHidden(true)
      const fetcher = vi.fn(async () => 1)
      renderHook(() => useResource('k', fetcher, { refreshMs: 1000, hiddenRefreshMs: 5000 }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4900)
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('refreshes at once when the tab comes back and the slow cadence left the data old', async () => {
      vi.useFakeTimers()
      setHidden(true)
      const fetcher = vi.fn(async () => 1)
      renderHook(() => useResource('k', fetcher, { refreshMs: 1000, hiddenRefreshMs: 60_000 }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      await act(async () => {
        setHidden(false)
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  })

  describe('overlapping requests', () => {
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    afterEach(() => setHidden(false))

    /** A request the test answers when it chooses, so completion order is exact. */
    function controlled() {
      const calls: {
        signal: AbortSignal
        resolve: (v: number) => void
        reject: (e: Error) => void
      }[] = []
      const fetcher = vi.fn(
        (signal: AbortSignal) =>
          new Promise<number>((resolve, reject) => calls.push({ signal, resolve, reject })),
      )
      return { calls, fetcher }
    }

    /**
     * The first request is slow. The tab is hidden and comes back, so the slow cadence has left the
     * data older than the poll interval and a second request goes out while the first is still pending.
     */
    async function overlap(options: { hiddenRefreshMs?: number } = {}) {
      vi.useFakeTimers()
      const { calls, fetcher } = controlled()
      const hook = renderHook(() =>
        useResource('k', fetcher, { refreshMs: 1000, hiddenRefreshMs: 60_000, ...options }),
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(calls).toHaveLength(1)
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(calls).toHaveLength(2)
      return { ...hook, calls, fetcher }
    }

    it('does not let an older response overwrite a newer one, or take its timestamp', async () => {
      const { result, calls } = await overlap()
      vi.setSystemTime(Date.now() + 10_000)
      await act(async () => calls[1]!.resolve(2))
      const newer = result.current.updatedAt
      expect(result.current.data).toBe(2)

      vi.setSystemTime(Date.now() + 10_000)
      await act(async () => calls[0]!.resolve(1))

      expect(result.current.data).toBe(2)
      expect(result.current.updatedAt).toBe(newer)
      expect(result.current.isRefreshing).toBe(false)
    })

    it('does not let an older failure replace newer data with an error', async () => {
      const { result, calls } = await overlap()
      await act(async () => calls[1]!.resolve(2))

      await act(async () => calls[0]!.reject(new Error('late failure')))

      expect(result.current.data).toBe(2)
      expect(result.current.error).toBeNull()
    })

    it('aborts the request a newer one replaces', async () => {
      const { calls } = await overlap()
      expect(calls[0]!.signal.aborted).toBe(true)
      expect(calls[1]!.signal.aborted).toBe(false)
    })

    it('keeps exactly one polling timer, however the requests finish', async () => {
      const { calls } = await overlap()
      await act(async () => calls[1]!.resolve(2))
      await act(async () => calls[0]!.resolve(1))
      expect(vi.getTimerCount()).toBe(1)

      // And one request per interval from then on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(calls).toHaveLength(3)
    })

    it('still shows loading, not an error, while the only request in flight was replaced', async () => {
      vi.useFakeTimers()
      const { calls, fetcher } = controlled()
      const { result } = renderHook(() =>
        useResource('k', fetcher, { refreshMs: 1000, hiddenRefreshMs: 60_000 }),
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(0)
      })
      // The replaced request was cancelled, which is not a failure.
      await act(async () => calls[0]!.reject(new DOMException('aborted', 'AbortError')))
      expect(result.current.status).toBe('loading')
      expect(result.current.error).toBeNull()

      await act(async () => calls[1]!.resolve(7))
      expect(result.current.status).toBe('success')
      expect(result.current.data).toBe(7)
    })

    it('stops everything when the component goes away', async () => {
      const { calls, unmount } = await overlap()
      unmount()
      expect(calls.every((call) => call.signal.aborted)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
