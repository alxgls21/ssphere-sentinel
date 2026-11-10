import { ChevronDown, ChevronUp } from 'lucide-react'
import type { SortDirection } from '@/api/types'
import { cn } from '@/lib/cn'

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'

interface SortHeadProps<Query, Key extends string> {
  sortKey: Key
  query: Query
  onSort: (next: { sort: Key; dir: SortDirection }) => void
  className?: string
  title?: string
  label?: string
}

/** A column header that sorts: a real button inside the th, with aria-sort on the th. */
export function createSortHead<Key extends string, Query extends { sort: Key; dir: SortDirection }>(
  labels: Record<Key, string>,
  nextSort: (query: Query, key: Key) => { sort: Key; dir: SortDirection },
) {
  return function SortHead({
    sortKey,
    query,
    onSort,
    className,
    title,
    label,
  }: SortHeadProps<Query, Key>) {
    const active = query.sort === sortKey
    const Arrow = query.dir === 'asc' ? ChevronUp : ChevronDown
    return (
      <th
        scope="col"
        aria-sort={active ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cn(HEAD, className)}
      >
        <button
          type="button"
          title={title}
          onClick={() => onSort(nextSort(query, sortKey))}
          className={cn(
            'type-label inline-flex h-full items-center gap-1 rounded-sm px-1 -outline-offset-2 hover:text-fg',
            active && 'text-fg',
          )}
        >
          {(label ?? labels[sortKey]).toUpperCase()}
          <span aria-hidden="true" className="inline-block size-3">
            {active ? <Arrow className="size-3" strokeWidth={1.5} /> : null}
          </span>
        </button>
      </th>
    )
  }
}
