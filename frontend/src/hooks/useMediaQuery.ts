import { useCallback, useSyncExternalStore } from 'react'

/**
 * Subscribes to a CSS media query. Prefer CSS for presentation; use this only
 * where the DOM itself must differ (one instance rendered either inline or
 * inside an accordion) so a component is never mounted twice.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = () => window.matchMedia(query).matches
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
