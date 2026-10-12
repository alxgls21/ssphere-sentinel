import type { SiteEntity } from '@/api/types'
import { compareSeverity } from '@/lib/status'

/** Ids are only unique within a kind, so anything keyed per entity uses kind + id. */
export function entityKey(entity: SiteEntity): string {
  return `${entity.kind}:${entity.id}`
}

/** Critical first, healthy last; entities of equal status keep the order they came in. */
export function worstFirst(entities: readonly SiteEntity[]): SiteEntity[] {
  return entities.toSorted((a, b) => compareSeverity(a.status, b.status))
}
