import { useEffect, useState } from 'react'

/**
 * True only after `flag` has been true for `delayMs`. Used so a skeleton never
 * flashes for a fast response: loading shorter than the delay shows nothing.
 */
export function useDelayedFlag(flag: boolean, delayMs = 150): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!flag) return
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => {
      clearTimeout(timer)
      setElapsed(false)
    }
  }, [flag, delayMs])
  return flag && elapsed
}
