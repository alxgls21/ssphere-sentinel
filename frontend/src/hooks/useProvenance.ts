import { useApi } from '@/api/context'
import { FEATURES, isUnimplemented, type FeatureId } from '@/config/features'

export interface Provenance {
  /** 'mock' until a real adapter is provided. */
  source: 'mock' | 'http'
  /** True when every feature behind this panel is unimplemented in the backend. */
  planned: boolean
  /** The backend notes of the unimplemented features, for tooltips and descriptions. */
  note: string
}

/**
 * Provenance is derived, never hand-placed: from the API source and the
 * FEATURES registry. Flip one registry entry when the backend gains a
 * capability and every marker for it disappears.
 */
export function useProvenance(features: FeatureId | readonly FeatureId[]): Provenance {
  const { source } = useApi()
  const list: readonly FeatureId[] = typeof features === 'string' ? [features] : features
  const missing = list.filter(isUnimplemented)
  return {
    source,
    planned: list.length > 0 && missing.length === list.length,
    note: missing.map((id) => FEATURES[id].note).join(' '),
  }
}
