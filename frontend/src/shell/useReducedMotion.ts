import { usePrefs } from '@/app/prefs'
import { useMediaQuery } from '@/hooks/useMediaQuery'

/** The OS asks for reduced motion, or the operator forced it in the Display menu. */
export function useReducedMotion(): boolean {
  const { motion } = usePrefs()
  const system = useMediaQuery('(prefers-reduced-motion: reduce)')
  return system || motion === 'reduce'
}
