export const LOGIN_PATH = '/login'

/** The parser answers with this origin for an in-app path, so anything pointing elsewhere is visible. */
const BASE = 'http://app.invalid'
const MAX_LENGTH = 2048

/**
 * The page to return to after signing in, from `?next=`. Only a path inside
 * this application is accepted: external URLs, protocol-relative ones
 * (`//host`), other schemes, backslash tricks and control characters all fall
 * back to `fallback`, as does the sign-in page itself (no redirect loop).
 * The result is rebuilt from the parsed URL, never echoed from the input.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/'): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_LENGTH) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
  // Backslashes (browsers treat them as slashes) and control characters, including tab and newline.
  // oxlint-disable-next-line no-control-regex
  if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return fallback
  let url: URL
  try {
    url = new URL(raw, BASE)
  } catch {
    return fallback
  }
  if (url.origin !== BASE || url.pathname.startsWith('//')) return fallback
  if (url.pathname === LOGIN_PATH || url.pathname.startsWith(`${LOGIN_PATH}/`)) return fallback
  return `${url.pathname}${url.search}${url.hash}`
}

/** The sign-in page's address for a page that needs a session. */
export function loginPath(next: string, reason?: 'expired'): string {
  const params = new URLSearchParams()
  const target = safeNextPath(next)
  if (target !== '/') params.set('next', target)
  if (reason) params.set('reason', reason)
  const text = params.toString()
  return text ? `${LOGIN_PATH}?${text}` : LOGIN_PATH
}
