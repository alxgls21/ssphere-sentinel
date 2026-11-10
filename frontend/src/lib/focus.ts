/** Engines without :focus-visible are treated as keyboard focus. */
export function focusIsVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}
