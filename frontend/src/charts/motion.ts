/** True when the user asked the OS for less motion. Evaluated per call, never cached. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/**
 * True when animation must be off: the OS setting, or the Display menu's
 * override (PrefsProvider mirrors it onto html[data-motion="reduce"]).
 */
export function isMotionReduced(): boolean {
  return (
    prefersReducedMotion() ||
    (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce')
  )
}
