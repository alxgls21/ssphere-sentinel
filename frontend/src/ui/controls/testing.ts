import { vi } from 'vitest'

// Captured at import, before any spy, so stubbing twice never calls itself.
const matches = Element.prototype.matches

/**
 * jsdom decides :focus-visible with its own input-event heuristic, and that
 * state leaks from one test to the next. Tooltips open on keyboard focus only,
 * so tests that depend on it pin the answer: every focus is keyboard focus
 * unless `keyboard` is false (a mouse click). Undo with vi.restoreAllMocks().
 */
export function stubFocusVisible(keyboard = true): void {
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    if (selector === ':focus-visible') return keyboard && this === document.activeElement
    return matches.call(this, selector)
  })
}
