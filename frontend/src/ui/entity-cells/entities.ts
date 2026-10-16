import type { SiteEntity } from '@/api/types'
import { DISPLAY_ORDER, displayStatus } from '@/lib/status'

/** Ids are only unique within a kind, so anything keyed per entity uses kind + id. */
export function entityKey(entity: SiteEntity): string {
  return `${entity.kind}:${entity.id}`
}

/** The state a cell shows: the health status, or offline for a server whose agent stopped reporting. */
export const displayOf = (entity: SiteEntity) => displayStatus(entity.status, entity.offline)

/**
 * Critical first, healthy last, with offline directly after the rest of critical
 * (the order of every bar); entities of equal state keep the order they came in.
 */
export function worstFirst(entities: readonly SiteEntity[]): SiteEntity[] {
  const rank = (entity: SiteEntity) => DISPLAY_ORDER.indexOf(displayOf(entity))
  return entities.toSorted((a, b) => rank(a) - rank(b))
}
