import type { HealthStatus, SiteEntity } from '@/api/types'
import { nonZeroCounts, spokenStatus } from '@/lib/blocks'
import { countStatuses } from '@/lib/status'

/** Statuses whose members are named in the label: the ones someone has to look at. */
const NAMED: readonly HealthStatus[] = ['critical', 'warning', 'unknown']
/** Names listed per status before "+N more"; a long list is noise read aloud. */
const MAX_NAMES = 3
/** Entity names are free text from the backend: cap what one label can carry. */
const MAX_NAME_LENGTH = 32

const clip = (name: string) =>
  name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name

/**
 * The accessible name of a strip row, which is decorative itself:
 * "Acme / Athens-DC: 2 critical (edge-gw-02, acme-vpn:443), 1 warning (api-02), 15 ok".
 * Critical, warning and unknown entities are named (worst first, a few per
 * status); healthy and idle ones are only counted.
 */
export function describeEntities(label: string, entities: readonly SiteEntity[]): string {
  if (entities.length === 0) return `${label}: no entities`
  const parts = nonZeroCounts(countStatuses(entities.map((entity) => entity.status))).map(
    ({ status, count }) => {
      const head = `${count} ${spokenStatus(status)}`
      if (!NAMED.includes(status)) return head
      const names = entities.filter((entity) => entity.status === status).map((e) => clip(e.name))
      const hidden = names.length - MAX_NAMES
      const listed = hidden > 0 ? [...names.slice(0, MAX_NAMES), `+${hidden} more`] : names
      return `${head} (${listed.join(', ')})`
    },
  )
  return `${label}: ${parts.join(', ')}`
}
