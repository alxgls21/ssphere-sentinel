/**
 * Moves focus to the Needs attention panel ([1]), scrolled to its top. The
 * panel is found by its index attribute because the hero cannot import the
 * queue (features never import each other); it does nothing when the queue is
 * not on screen.
 */
export function focusAttentionPanel(): void {
  const panel = document.querySelector<HTMLElement>('[data-panel="1"]')
  if (!panel) return
  panel.scrollIntoView({ block: 'start' })
  panel.focus({ preventScroll: true })
}
