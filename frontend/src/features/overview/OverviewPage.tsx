import { useMediaQuery } from '@/hooks/useMediaQuery'
import { PanelBoundary } from '@/ui/PanelBoundary'
import { ActiveAlertsPanel } from './alerts'
import { AlertsProvider } from './AlertsProvider'
import { RecentEventsPanel } from './events'
import { HeroStrip, VerdictBar } from './hero'
import { InfrastructureHealthPanel } from './health'
import { NetworkLatencyPanel } from './latency/NetworkLatencyPanel'
import { FleetLoadPanel } from './load'
import { PlannedAccordion } from './PlannedAccordion'
import { AttentionQueuePanel } from './queue/AttentionQueuePanel'

/**
 * The Overview, read in a fixed order: the verdict (0-2 s), the Needs
 * attention queue and tiles (2-10 s), context charts and health (10-60 s),
 * then the PLANNED alerts and events (background).
 *
 * Geometry (rem, 1rem = 16px) at the 1440x900 reference, no page scroll:
 *   strip 7.5 + gap 0.75 + main 42.25 = 50.5 (808px = 832px viewport - 24px page padding)
 *   left (8 cols)  queue 21.25 + 0.75 + charts 20.25
 *   right (4 cols) health 19.25 + 0.75 + alerts 10.375 + 0.75 + events 11.125
 * Rows are `minmax(min, min-fr)`, so a taller window stretches them in
 * proportion and a shorter one falls back to the minimum (the page scrolls).
 * The root needs a DEFINITE height at xl (h-full): fr rows in an auto-height
 * grid would size to their content instead, and the queue would grow forever.
 *
 * Reflow: xl two columns; lg queue full width, charts 6/6, then health /
 * alerts / events 4/4/4; md the same but health full width and the planned
 * panels folded into one accordion; below md a single column, reordered so
 * the queue comes first and the compact verdict bar sticks to the top.
 *
 * The `contents` wrappers dissolve at smaller sizes, so every panel becomes a
 * direct grid (or, on phones, flex) item and can be placed or reordered.
 */
/**
 * Where each panel sits at every breakpoint. One constant per panel, so the
 * panel and its error fallback (PanelBoundary) occupy the same grid cell.
 */
const PLACE = {
  queue:
    'min-h-[21.25rem] max-md:order-1 md:col-span-12 md:h-[21.25rem] xl:col-span-1 xl:h-auto xl:min-h-0',
  latency: 'min-h-[20.25rem] max-md:order-5 md:col-span-6 xl:col-span-1 xl:min-h-0',
  load: 'min-h-[20.25rem] max-md:order-4 md:col-span-6 xl:col-span-1 xl:min-h-0',
  health: 'min-h-[19.25rem] max-md:order-3 md:col-span-12 lg:col-span-4 xl:col-span-1 xl:min-h-0',
  alerts: 'min-h-[10.375rem] lg:col-span-4 xl:col-span-1',
  events: 'min-h-[11.125rem] lg:col-span-4 xl:col-span-1',
} as const

export default function OverviewPage() {
  const lgUp = useMediaQuery('(min-width: 64rem)')

  const alerts = (
    <PanelBoundary title="Active alerts" index={5} features="alerts" className={PLACE.alerts}>
      <ActiveAlertsPanel className={PLACE.alerts} />
    </PanelBoundary>
  )
  const events = (
    <PanelBoundary title="Recent events" index={6} features="events" className={PLACE.events}>
      <RecentEventsPanel className={PLACE.events} />
    </PanelBoundary>
  )

  return (
    <AlertsProvider>
      <div className="flex min-h-full flex-col gap-3 xl:h-full xl:min-h-[50.5rem]">
        <h1 className="sr-only">Overview</h1>

        {/* Phones only: the verdict sticks under the app bar; the full hero is hidden below md. */}
        <div className="sticky -top-3 z-20 -mx-3 -mt-3 md:hidden">
          <VerdictBar />
        </div>

        <div className="max-md:order-2">
          <HeroStrip />
        </div>

        <div className="contents md:grid md:grid-cols-12 md:gap-3 xl:min-h-0 xl:flex-1 xl:grid-rows-[minmax(42.25rem,1fr)]">
          <div className="contents xl:col-span-8 xl:grid xl:min-h-0 xl:grid-rows-[minmax(21.25rem,21.25fr)_minmax(20.25rem,20.25fr)] xl:gap-3">
            <PanelBoundary
              title="Needs attention"
              index={1}
              features={['servers', 'docker', 'network']}
              className={PLACE.queue}
            >
              <AttentionQueuePanel className={PLACE.queue} />
            </PanelBoundary>
            <div className="contents xl:grid xl:min-h-0 xl:grid-cols-2 xl:gap-3">
              <PanelBoundary
                title="Network latency"
                index={2}
                features="network"
                className={PLACE.latency}
              >
                <NetworkLatencyPanel className={PLACE.latency} />
              </PanelBoundary>
              <PanelBoundary title="Fleet load" index={3} features="servers" className={PLACE.load}>
                <FleetLoadPanel className={PLACE.load} />
              </PanelBoundary>
            </div>
          </div>

          <div className="contents xl:col-span-4 xl:grid xl:min-h-0 xl:grid-rows-[minmax(19.25rem,19.25fr)_minmax(10.375rem,10.375fr)_minmax(11.125rem,11.125fr)] xl:gap-3">
            <PanelBoundary
              title="Infrastructure health"
              index={4}
              features={['servers', 'docker', 'network', 'snmp', 'site-links']}
              className={PLACE.health}
            >
              <InfrastructureHealthPanel className={PLACE.health} />
            </PanelBoundary>
            {lgUp ? (
              <>
                {alerts}
                {events}
              </>
            ) : (
              <PlannedAccordion className="max-md:order-6 md:col-span-12" count={2}>
                {alerts}
                {events}
              </PlannedAccordion>
            )}
          </div>
        </div>
      </div>
    </AlertsProvider>
  )
}
