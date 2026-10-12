/** `navigator.userAgentData` is not in the DOM lib yet; only the part we read is declared. */
interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: { platform?: string }
}

/**
 * True on macOS, where the shortcut modifier is Command. `userAgentData` is the
 * current source; `navigator.platform` is the fallback for browsers without it
 * (it is deprecated but still reports "MacIntel"). Read on every call so tests
 * can stub the navigator.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as NavigatorWithUserAgentData
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /mac/i.test(platform)
}

/** Label of the primary shortcut modifier: the Command symbol on macOS, "Ctrl" elsewhere. */
export function modKeyLabel(): string {
  return isMac() ? '⌘' : 'Ctrl'
}
