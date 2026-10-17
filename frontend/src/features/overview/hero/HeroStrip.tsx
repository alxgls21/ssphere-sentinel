import { ContainersTile, DevicesTile, ServersTile, TargetsTile } from './DomainTiles'
import { AlertsTile } from './PlannedTiles'
import { VerdictHero } from './VerdictHero'

/**
 * The top strip: the verdict and five domain tiles.
 *
 *   xl and up  one 7.5rem row: verdict 1.7fr + five tiles (291 + 5 x 171 at 1440)
 *   lg         verdict full width on one 88px line, then five tiles at 1fr
 *   md         six columns: verdict full width, tiles 3 + 2
 *   below md   two columns, the verdict hidden (the page shows the compact
 *              VerdictBar instead), net targets full width so devices and
 *              alerts close the grid together
 *
 * Row heights are fixed so no state (loading, error, stale) can move the page.
 */
export function HeroStrip() {
  return (
    <section
      aria-label="Fleet summary"
      className="grid auto-rows-[7.5rem] grid-cols-2 gap-3 md:grid-cols-6 md:grid-rows-[5.5rem] lg:grid-cols-5 xl:grid-cols-[minmax(0,1.7fr)_repeat(5,minmax(0,1fr))] xl:grid-rows-[7.5rem]"
    >
      <div className="hidden min-w-0 md:col-span-6 md:block lg:col-span-5 xl:col-span-1">
        <VerdictHero />
      </div>
      <ServersTile className="md:col-span-2 lg:col-span-1" />
      <ContainersTile className="md:col-span-2 lg:col-span-1" />
      <TargetsTile className="col-span-2 lg:col-span-1" />
      <DevicesTile className="md:col-span-3 lg:col-span-1" />
      <AlertsTile className="md:col-span-3 lg:col-span-1" />
    </section>
  )
}
