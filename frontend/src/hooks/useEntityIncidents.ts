import { useApi } from '@/api/context'
import type { IncidentItem, IncidentKindFilter } from '@/api/types'
import { useLive } from '@/app/live'
import { useResource } from './useResource'

/** The most one chart asks for: more incidents of one object than this in a range is not a case to draw. */
const LIMIT = 200

/**
 * The incidents of one object, for the marks on its history. The search is by the object's id and the
 * answer is narrowed to it by the caller. A reading that fails is only a chart without marks: it never
 * blocks the page, raises no banner and never touches the freshness of the screen.
 */
export function useEntityIncidents(
  kind: Exclude<IncidentKindFilter, 'all'>,
  id: string,
): { items: IncidentItem[]; nowMs: number } {
  const api = useApi()
  const { pollMs, paused } = useLive()
  const resource = useResource(
    `entity-incidents:${kind}:${id}`,
    (signal) => api.listIncidents({ kind, q: id, status: 'all', pageSize: LIMIT, signal }),
    { refreshMs: pollMs, paused, keepPreviousData: true },
  )
  const list = resource.data
  return { items: list?.items ?? [], nowMs: list ? Date.parse(list.generatedAt) : 0 }
}
