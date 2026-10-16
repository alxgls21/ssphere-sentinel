import { useId } from 'react'
import { Link } from 'react-router'
import { useApi } from '@/api/context'
import type { SiteBreakdown } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { FEATURES, shortfallOf } from '@/config/features'
import { worstStatus } from '@/lib/status'
import { EntityCells, describeEntities } from '@/ui/entity-cells'
import { PlaceName } from '@/ui/PlaceName'
import { FeatureChip } from '@/ui/provenance/Chips'
import { StatusGlyph } from '@/ui/status'
import { NAME_RESERVE_PX, siteLabel, siteTarget } from './healthModel'
import { useStripCapacity } from './useStripCapacity'

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
 * BY SITE: the worst sites first. While the console does not read the site
 * assignment of servers, containers and targets from the backend, this whole
 * section is sample data and says so; the panel frame stays solid because the
 * domain rows above it are real.
 */
export function SiteSection({ sites }: { sites: readonly SiteBreakdown[] }) {
  const { source } = useApi()
  const headingId = useId()
  const noteId = useId()
  const shortfall = shortfallOf('site-links', source)
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
            <span id={noteId} className="sr-only">
              {FEATURES['site-links'].note}
            </span>
          </>
        ) : null}
      </div>
      {sites.length > 0 ? (
        <ul aria-labelledby={headingId} aria-describedby={shortfall ? noteId : undefined}>
          {sites.map((site) => (
            <SiteRow key={site.siteId} site={site} />
          ))}
        </ul>
      ) : (
        <p className="type-body flex h-(--row-h) items-center text-fg-muted">
          No site assignments yet
        </p>
      )}
    </div>
  )
}
