import type { DomainBreakdown } from '@/api/types'
import { GlyphCounts } from '@/ui/entity-cells'
import { SegmentedBar } from '@/ui/meters'
import { PlannedChip } from '@/ui/provenance/Chips'
import { DOMAIN_NAME, isUncounted } from './healthModel'

/**
 * One row per monitored domain: label, an 8px worst-first bar, glyph-coded
 * counts. The rows share three grid columns, so every bar starts and ends in
 * the same place however wide a row's counts are.
 */
export function DomainRows({ domains }: { domains: readonly DomainBreakdown[] }) {
  return (
    <ul className="grid grid-cols-[6rem_minmax(0,1fr)_auto] gap-x-3 @max-sm:grid-cols-1">
      {domains.map((domain) => (
        <li
          key={domain.domain}
          className="col-span-3 grid h-(--row-h) grid-cols-subgrid items-center @max-sm:col-span-1 @max-sm:h-auto @max-sm:grid-cols-[minmax(0,1fr)_auto] @max-sm:gap-y-1 @max-sm:py-1.5"
        >
          <span className="type-label truncate text-fg-muted">{domain.label}</span>
          <SegmentedBar
            counts={domain.counts}
            height={8}
            label={DOMAIN_NAME[domain.domain]}
            planned={domain.planned}
            plannedText="no SNMP data"
            className="min-w-0 @max-sm:col-span-2 @max-sm:row-start-2"
          />
          {domain.planned ? (
            <PlannedChip className="@max-sm:col-start-2 @max-sm:row-start-1" />
          ) : (
            // The bar already names every count; this is the same numbers for the eye.
            <span aria-hidden="true" className="@max-sm:col-start-2 @max-sm:row-start-1">
              {isUncounted(domain.counts) ? (
                <span className="type-data text-fg-faint">none</span>
              ) : (
                <GlyphCounts counts={domain.counts} />
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
