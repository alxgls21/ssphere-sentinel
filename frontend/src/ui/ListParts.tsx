import type { PageInfo } from '@/api/types'
import { formatInteger } from '@/lib/format'
import { Button } from '@/ui/controls'
import { Skeleton } from '@/ui/states'

const SKELETON_ROWS = 8

/** Placeholder rows at the row height of a list, so the frame does not move when the rows arrive. */
export function ListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex h-(--row-h) items-center px-3">
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

interface PagerProps {
  page: PageInfo
  /** Rows on this page. */
  shown: number
  onPage: (number: number) => void
}

/** Where this page sits among the matches, and the way to the others. */
export function Pager({ page, shown, onPage }: PagerProps) {
  const first = (page.number - 1) * page.size + 1
  const last = first + shown - 1
  return (
    <nav aria-label="Pages" className="ml-auto flex shrink-0 items-center gap-2">
      <span className="type-data tnum" aria-live="polite">
        {shown > 0 ? `${first}–${last} of ${formatInteger(page.total)} · ` : ''}
        page {page.number} of {page.pages}
      </span>
      <Button size="sm" disabled={page.number <= 1} onClick={() => onPage(page.number - 1)}>
        Previous
      </Button>
      <Button
        size="sm"
        disabled={page.number >= page.pages}
        onClick={() => onPage(page.number + 1)}
      >
        Next
      </Button>
    </nav>
  )
}
