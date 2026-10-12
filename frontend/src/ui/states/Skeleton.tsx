import { cn } from '@/lib/cn'

/** Decorative placeholder block. Always aria-hidden: the region announces loading itself. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('animate-skeleton rounded-sm bg-hover', className)} />
  )
}

/** Placeholder rows at the real row height, so loading never shifts layout. */
export function SkeletonRows({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-1.5', className)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-5" />
      ))}
    </div>
  )
}
