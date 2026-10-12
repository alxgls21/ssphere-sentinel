import { Skeleton } from '@/ui/states'

/** Loading placeholder at the real header and row heights, so the table never shifts when data lands. */
export function QueueSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className="h-6 border-b border-border bg-raised @max-md:hidden" />
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex h-(--row-h) items-center gap-3 border-b border-border px-3 @max-md:h-15"
        >
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  )
}
