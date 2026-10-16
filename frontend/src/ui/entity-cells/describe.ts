import type { SiteEntity } from '@/api/types'
import { nonZeroCounts, spokenStatus } from '@/lib/blocks'
import { countEntities, type DisplayStatus } from '@/lib/status'
import { displayOf } from './entities'

/** States whose members are named in the label: the ones someone has to look at. */
const NAMED: readonly DisplayStatus[] = ['critical', 'offline', 'warning', 'unknown']
/** Names listed per status before "+N more"; a long list is noise read aloud. */
const MAX_NAMES = 3
/** Entity names are free text from the backend: cap what one label can carry. */
const MAX_NAME_LENGTH = 32

const clip = (name: string) =>
  name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name

/**
 * The accessible name of a strip row, which is decorative itself:
 * "Acme / Athens-DC: 2 critical (edge-gw-02, acme-vpn:443), 1 offline (pir-fs-01), 1 warning (api-02), 15 ok".
 * Critical, offline, warning and unknown entities are named (worst first, a few
 * per status); healthy and idle ones are only counted.
 */
export function describeEntities(label: string, entities: readonly SiteEntity[]): string {
  if (entities.length === 0) return `${label}: no entities`
  const parts = nonZeroCounts(countEntities(entities)).map(({ status, count }) => {
    const head = `${count} ${spokenStatus(status)}`
    if (!NAMED.includes(status)) return head
    const names = entities.filter((entity) => displayOf(entity) === status).map((e) => clip(e.name))
    const hidden = names.length - MAX_NAMES
    const listed = hidden > 0 ? [...names.slice(0, MAX_NAMES), `+${hidden} more`] : names
    return `${head} (${listed.join(', ')})`
  })
  return `${label}: ${parts.join(', ')}`
}
