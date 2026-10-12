import { useCallback, useState, type RefCallback } from 'react'
import { MAX_STRIP_CAPACITY, capacityFor } from './healthModel'

/**
 * How many strip cells fit in the element it is attached to, after setting
 * aside `reservedPx` for whatever else shares its row (the site name). Starts
 * at the design maximum (so nothing collapses before the first measurement)
 * and follows the element's own width, which is what lets a narrow panel
 * collapse its strips to bar plus counts sooner than a wide one: a container
 * query, answered in script because the collapse swaps one component for another.
 */
export function useStripCapacity(reservedPx = 0): readonly [RefCallback<HTMLElement>, number] {
  const [capacity, setCapacity] = useState(MAX_STRIP_CAPACITY)
  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return
      const observer = new ResizeObserver(([entry]) => {
        const width = entry?.contentRect.width ?? 0
        // A hidden element reports no width: keep the last answer rather than collapse everything.
        if (width > 0) setCapacity(capacityFor(width - reservedPx))
      })
      observer.observe(element)
      return () => observer.disconnect()
    },
    [reservedPx],
  )
  return [ref, capacity] as const
}
