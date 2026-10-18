import { useSyncExternalStore } from 'react'

const subscribeNever = () => () => undefined
const subscribeEachSecond = (tick: () => void) => {
  const timer = setInterval(tick, 1000)
  return () => clearInterval(timer)
}
const wholeSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Seconds left until `until` (epoch ms), counted down once a second while there is a wait, or 0
 * when there is none (no timer runs then). The screen reader is told the wait once, when it
 * starts; this ticking is for the eye.
 */
export function useCountdown(until: number | null): number {
  const nowSeconds = useSyncExternalStore(
    until === null ? subscribeNever : subscribeEachSecond,
    wholeSeconds,
  )
  return until === null ? 0 : Math.max(0, Math.ceil(until / 1000) - nowSeconds)
}
