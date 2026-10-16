import type { StatusCounts } from '@/api/types'
import { formatInteger } from '@/lib/format'
import { StatusTag } from '@/ui/status'
import { domainShares } from './healthModel'

/**
 * The breakdown behind a domain row's bar, for the row's tooltip: every state
 * that has members with its count and its share of the domain total. The bar's
 * accessible name lists the same counts; this adds the shares and the total.
 */
export function DomainTip({ name, counts }: { name: string; counts: StatusCounts }) {
  const { total, rows } = domainShares(counts)
  const hasOffline = rows.some(({ status }) => status === 'offline')
  return (
    <div className="flex flex-col gap-1">
      {/* The literal spaces keep the spoken description "Servers 16 total": they take no room in a flex or grid row. */}
      <p className="flex items-baseline justify-between gap-4">
        <span>{name}</span> <span className="tnum text-fg-muted">{formatInteger(total)} total</span>
      </p>
      <ul className="tnum grid grid-cols-[1fr_auto_auto] gap-x-3">
        {rows.map(({ status, count, share }) => (
          <li key={status} className="col-span-3 grid grid-cols-subgrid items-center">
            <StatusTag status={status} /> <span className="text-right">{formatInteger(count)}</span>{' '}
            <span className="text-right text-fg-muted">{share}</span>
          </li>
        ))}
      </ul>
      {hasOffline ? (
        <p className="type-body text-fg-muted">
          Offline counts as critical in the verdict, which makes {formatInteger(counts.critical)} of{' '}
          {formatInteger(total)} critical.
        </p>
      ) : null}
    </div>
  )
}
