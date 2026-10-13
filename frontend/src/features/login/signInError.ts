import { ApiError } from '@/api/errors'

/** What the person is told for each way a sign-in can fail. Never more than the server said. */
export function describeSignInError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return error.message
    if (error.status === 400) return 'Enter your user name and password.'
    if (error.code === 'network' || error.code === 'timeout') {
      return 'Cannot reach the server. Check the connection and try again.'
    }
    if (error.status === 403)
      return 'The sign-in could not be verified. Reload the page and try again.'
    if (error.status !== null && error.status >= 500)
      return 'The server could not complete the sign-in. Try again shortly.'
    return error.message
  }
  return 'The sign-in failed. Try again.'
}
