/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A domain row is read, not operated. It takes a tab stop anyway so a keyboard user can open the
   tooltip (each state's share of the total) that a pointer gets on hover. There is one per counted domain. */
import { useApi } from '@/api/context'
import type { DomainBreakdown } from '@/api/types'
import { Tooltip } from '@/ui/controls'
import { GlyphCounts } from '@/ui/entity-cells'
import { SegmentedBar } from '@/ui/meters'
import { FEATURES, shortfallOf } from '@/config/features'
import { FeatureChip } from '@/ui/provenance/Chips'
import { DomainTip } from './DomainTip'
import { DOMAIN_NAME, isUncounted } from './healthModel'

function DomainRow({ domain }: { domain: DomainBreakdown }) {
  const { source } = useApi()
  // A planned row holds no figures and an uncounted one has nothing to break down: neither claims numbers.
  const detail =
    domain.planned || isUncounted(domain.counts) ? null : (
      <DomainTip name={DOMAIN_NAME[domain.domain]} counts={domain.counts} />
    )
  return (
    <Tooltip content={detail}>
      <li
        tabIndex={detail ? 0 : undefined}
        className="col-span-3 grid h-(--row-h) grid-cols-subgrid items-center @max-sm:col-span-1 @max-sm:h-auto @max-sm:grid-cols-[minmax(0,1fr)_auto] @max-sm:gap-y-1 @max-sm:py-1.5"
      >
        <span className="type-label truncate text-fg-muted">{domain.label}</span>
        <SegmentedBar
          counts={domain.counts}
          height={8}
          label={DOMAIN_NAME[domain.domain]}
          planned={domain.planned}
          plannedText="no SNMP data"
          segmentTitles={false}
          className="min-w-0 @max-sm:col-span-2 @max-sm:row-start-2"
        />
        {domain.planned ? (
          <FeatureChip
            availability={shortfallOf('snmp', source) ?? 'unknown'}
            title={FEATURES.snmp.note}
            className="@max-sm:col-start-2 @max-sm:row-start-1"
          />
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
    </Tooltip>
  )
}

/**
 * One row per monitored domain: label, an 8px worst-first bar, glyph-coded
 * counts. The rows share three grid columns, so every bar starts and ends in
 * the same place however wide a row's counts are. Hovering or focusing a row
 * lists every state with its share of the domain total.
 */
export function DomainRows({ domains }: { domains: readonly DomainBreakdown[] }) {
  return (
    <ul className="grid grid-cols-[6rem_minmax(0,1fr)_auto] gap-x-3 @max-sm:grid-cols-1">
      {domains.map((domain) => (
        <DomainRow key={domain.domain} domain={domain} />
      ))}
    </ul>
  )
}
