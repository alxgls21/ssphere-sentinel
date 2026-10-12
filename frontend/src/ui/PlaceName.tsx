import { cn } from '@/lib/cn'

interface PlaceNameProps {
  customer: string
  site: string
  className?: string
}

/**
 * "Customer / Site" that stays distinguishable when it does not fit. Plain
 * truncation cuts from the right, which removes exactly the part that tells two
 * sites of one customer apart ("Meridian Logistics / ..." twice). Here the
 * customer gives way first and the site name stays whole. Truncation is only
 * visual: the DOM text (and so the accessible name) is always complete.
 */
export function PlaceName({ customer, site, className }: PlaceNameProps) {
  return (
    <span title={`${customer} / ${site}`} className={cn('flex min-w-0 items-baseline', className)}>
      <span className="min-w-0 truncate">{customer}</span>
      <span className="shrink-0 whitespace-pre">{` / ${site}`}</span>
    </span>
  )
}
