import { createContext, useContext } from 'react'
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from '@/lib/thresholds'

/**
 * The resource limits in force, and whose they are: the console API's (published with the
 * session) or the console's own defaults. Meters read them from here, so a screen that
 * draws a limit and a meter that crosses it never disagree.
 */
export interface ResourceLimitsInForce extends ResourceLimits {
  origin: 'server' | 'default'
}

export const DEFAULT_LIMITS_IN_FORCE: ResourceLimitsInForce = {
  ...DEFAULT_RESOURCE_LIMITS,
  origin: 'default',
}

export const ResourceLimitsContext = createContext<ResourceLimitsInForce>(DEFAULT_LIMITS_IN_FORCE)

export const useResourceLimits = (): ResourceLimitsInForce => useContext(ResourceLimitsContext)

/** How a limit is attributed where it is written out ("UI defaults", "set on the server"). */
export const limitsOrigin = (limits: ResourceLimitsInForce): string =>
  limits.origin === 'server' ? 'set on the server' : 'UI defaults'
