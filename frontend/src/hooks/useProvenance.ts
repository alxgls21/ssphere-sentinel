import { useApi } from '@/api/context'
import {
  FEATURES,
  availabilityOf,
  DATA_FEATURES,
  isPlaceholder,
  provenanceOf,
  type Availability,
  type FeatureId,
  type Provenance as ProvenanceKind,
} from '@/config/features'

export interface Provenance {
  /**
   * What the content behind these features may claim (`live`, `mock`, `unknown`), from their
   * availability and the adapter. The adapter alone never makes content live.
   */
  provenance: ProvenanceKind
  /** True when nothing real is shown behind this panel (unsupported, or an empty placeholder): a dashed frame. */
  planned: boolean
  /** Why, when `planned`: the availability its chip names. */
  availability: Exclude<Availability, 'live'> | null
  /** The registry notes of the features behind it, for tooltips and descriptions. */
  note: string
}

/**
 * Provenance is derived, never hand-placed: from the features a component is
 * made of, the registry, and the API source. A component with no feature to judge
 * it by (an empty list) is `unknown`, never live. Change one registry entry when the
 * backend or the console changes and every marker follows.
 */
export function useProvenance(features: FeatureId | readonly FeatureId[]): Provenance {
  const { source } = useApi()
  const list: readonly FeatureId[] = typeof features === 'string' ? [features] : features
  const held = list.filter((id) => isPlaceholder(id, source))
  const planned = list.length > 0 && held.length === list.length
  const shortfall = (id: FeatureId) => availabilityOf(id, source) as Exclude<Availability, 'live'>
  return {
    provenance: provenanceOf(list, source),
    planned,
    // Every feature planned: PLANNED. Otherwise name the first reason that is not "planned".
    availability: !planned
      ? null
      : held.every((id) => availabilityOf(id, source) === 'planned')
        ? 'planned'
        : shortfall(held.find((id) => availabilityOf(id, source) !== 'planned') as FeatureId),
    note: held.map((id) => FEATURES[id].note).join(' '),
  }
}

/**
 * Whether the app as a whole still shows demo data: true until every feature the screens
 * show is live. The adapter's source is not enough, so a partly connected adapter keeps
 * saying so (top bar chip, notice strip, status bar, tab title).
 */
export function useShowsDemoData(): boolean {
  const { source } = useApi()
  return provenanceOf(DATA_FEATURES, source) !== 'live'
}
