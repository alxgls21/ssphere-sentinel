import type { AuthClient } from '../auth'
import type { ScopeOptions } from '../types'
import { createAuthClient, getScopeOptions } from './session'
import { createTransport, type TransportOptions } from './transport'

export interface ConsoleHttp {
  auth: AuthClient
  getScopeOptions: (signal?: AbortSignal) => Promise<ScopeOptions>
}

/**
 * What the Django console API serves today: the session and the scope. Servers,
 * containers and the rest are added here as the backend phases are integrated.
 */
export function createConsoleHttp(options: TransportOptions = {}): ConsoleHttp {
  const transport = createTransport(options)
  return { auth: createAuthClient(transport), getScopeOptions: getScopeOptions(transport) }
}

export { API_BASE } from './transport'
