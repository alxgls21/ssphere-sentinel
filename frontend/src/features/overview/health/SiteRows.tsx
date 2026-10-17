import { useId } from 'react'
import { Link } from 'react-router'
import { useApi } from '@/api/context'
import type { SiteBreakdown, SiteCoverage } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { FEATURES, shortfallOf } from '@/config/features'
import { worstStatus } from '@/lib/status'
import { EntityCells, describeEntities } from '@/ui/entity-cells'
import { PlaceName } from '@/ui/PlaceName'
import { FeatureChip } from '@/ui/provenance/Chips'
import { StatusGlyph } from '@/ui/status'
import { NAME_RESERVE_PX, siteLabel, siteTarget } from './healthModel'
import { useStripCapacity } from './useStripCapacity'

/** Said to everyone who reads the list, since a site with no problem is simply not in it. */
const PROBLEMS_ONLY =
  'The console API returns the worst rows of the fleet, not all of it. Every server and container that needs attention is listed under its site; the healthy and idle ones are not counted per site.'

function SiteRow({ site }: { site: SiteBreakdown }) {
  const [row, capacity] = useStripCapacity(NAME_RESERVE_PX)
  const name = siteLabel(site)
  const viewTo = useViewTo()
  const target = siteTarget(site.siteId)
  const worst = worstStatus(site.entities.map((entity) => entity.status))
  return (
    <li>
      {/* The strip is decorative, so the link's own label is what names every non-OK entity. */}
      <Link
        ref={row}
        to={viewTo(target.pathname, target.extra)}
        aria-label={describeEntities(name, site.entities)}
        className="-mx-3 flex min-h-(--row-h) items-center gap-2 px-3 transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:-outline-offset-2 @max-sm:flex-wrap @max-sm:py-1.5"
      >
        <span aria-hidden="true" className="flex size-2.5 shrink-0 items-center justify-center">
          <StatusGlyph status={worst} size={worst === 'healthy' ? 6 : 10} />
        </span>
        <PlaceName
          customer={site.customerName}
          site={site.siteName}
          className="type-body min-w-0 flex-1 @max-sm:w-[calc(100%-1.5rem)] @max-sm:flex-none"
        />
        {/* Right-aligned and only as wide as its content: a site with few entities leaves the rest to its name. */}
        <span className="shrink-0">
          <EntityCells variant="strip" entities={site.entities} capacity={capacity} label={name} />
        </span>
      </Link>
    </li>
  )
}

/**
 * BY SITE: the worst sites first, each with the servers and containers placed on it.
 * While the site assignment is not read from the console API (the sample API, or a
 * registry that says it is not connected), the section is marked as sample data;
 * the panel frame stays solid because the domain rows above it are counted.
 */
export function SiteSection({
  sites,
  coverage = 'all',
}: {
  sites: readonly SiteBreakdown[]
  /** How much of the fleet the rows rest on (see `SiteCoverage`). */
  coverage?: SiteCoverage
}) {
  const { source } = useApi()
  const headingId = useId()
  const noteId = useId()
  const shortfall = shortfallOf('site-links', source)
  const partial = coverage === 'problems'
  return (
    <div className="mt-1 border-t border-border">
      <div className="flex h-5 items-center gap-2">
        <h3 id={headingId} className="type-label text-fg-muted">
          By site{shortfall ? <span aria-hidden="true"> †</span> : null}
        </h3>
        {shortfall ? (
          <>
            <FeatureChip availability={shortfall} title={FEATURES['site-links'].note} />
            <span className="type-data truncate text-fg-faint">sample data</span>
          </>
        ) : null}
        {partial ? <span className="type-data truncate text-fg-faint">problems only</span> : null}
        <span id={noteId} className="sr-only">
          {shortfall ? FEATURES['site-links'].note : null}
          {shortfall && partial ? ' ' : null}
          {partial ? PROBLEMS_ONLY : null}
        </span>
      </div>
      {coverage === 'none' ? (
        <p className="type-body flex min-h-(--row-h) items-center py-1 text-fg-muted">
          Not available: more servers and containers need attention than one request returns, so no
          site can be totalled. This needs a per-site count from the console API.
        </p>
      ) : sites.length > 0 ? (
        <ul
          aria-labelledby={headingId}
          aria-describedby={shortfall || partial ? noteId : undefined}
        >
          {sites.map((site) => (
            <SiteRow key={site.siteId} site={site} />
          ))}
        </ul>
      ) : (
        <p className="type-body flex h-(--row-h) items-center text-fg-muted">
          {partial
            ? 'No server or container at any site needs attention'
            : 'No site assignments yet'}
        </p>
      )}
    </div>
  )
}
