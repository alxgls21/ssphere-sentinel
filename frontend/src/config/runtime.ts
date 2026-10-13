/**
 * How the console gets its data and who it lets in.
 *
 *   http  the Django console API: sign-in is required (the default)
 *   mock  the built-in sample fleet, no sign-in: for design work and tests only
 *
 * A production build can never run in mock mode: asking for it is an error,
 * not a silent fallback in either direction.
 */
export type ApiMode = 'http' | 'mock'

export interface RuntimeEnv {
  PROD: boolean
  VITE_SENTINEL_API?: string | undefined
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export function resolveApiMode({ PROD, VITE_SENTINEL_API }: RuntimeEnv): ApiMode {
  const value = (VITE_SENTINEL_API ?? '').trim().toLowerCase()
  if (value === '' || value === 'http') return 'http'
  if (value === 'mock') {
    if (PROD) {
      throw new ConfigurationError(
        'VITE_SENTINEL_API=mock is not allowed in a production build. Unset it to use the console API.',
      )
    }
    return 'mock'
  }
  throw new ConfigurationError(`VITE_SENTINEL_API must be "http" or "mock", not "${value}".`)
}
