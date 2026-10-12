/**
 * localStorage that never throws. Storage can be missing or blocked (private
 * windows, blocked site data, tests), so every read and write is guarded and
 * the UI must render correctly without it.
 */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* persistence is a convenience only */
  }
}
