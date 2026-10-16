import { lazy, Suspense, useMemo } from 'react'
import { usePrefs } from '@/app/prefs'
import { ChartTable } from '@/charts/ChartTable'
import { BASE_ROOT_PX } from '@/charts/theme'
import { ChartSkeleton } from '@/features/overview/latency/ChartSkeleton'
import { LATENCY_CHART_HEIGHT_PX } from '@/features/overview/latency/latencyGeometry'
import { latencyTable } from '@/features/overview/latency/latencyModel'
import { POLL_MS } from '@/lib/thresholds'
import { Panel } from '@/ui/Panel'
import { Skeleton } from '@/ui/states'
import { SAMPLE_SPIKE_SERIES } from '../sample/latency'
import { Specimen } from '../Specimen'

// The chart runtime is its own chunk, as it is on the Overview: the rest of the gallery paints first.
const LatencyChart = lazy(() => import('@/features/overview/latency/LatencyChart'))
const BandwidthChart = lazy(() => import('../sample/BandwidthChart'))

const PLOT_REM = LATENCY_CHART_HEIGHT_PX / BASE_ROOT_PX

export function ChartsSection() {
  const { tz } = usePrefs()
  const table = useMemo(() => latencyTable(SAMPLE_SPIKE_SERIES, '1h', tz), [tz])

  return (
    <div className="grid gap-x-3 gap-y-4 xl:grid-cols-2">
      <Specimen
        label="Chart frame"
        bare
        note="Two linked grids on one time axis, never a dual axis. Each grid draws its warn limit, a warning triangle marks every sample over it and the worst latency spike is labelled. The legend toggles series (Shift-click isolates). The plot takes focus: Left, Right, Home and End move the crosshair. The Table button shows the same values."
      >
        <Panel
          title="Network latency"
          features="network"
          scope="1h"
          refreshMs={POLL_MS}
          flush
          bodyClassName="px-3 py-2"
          footer={<span className="truncate">p95 and p50 across 40 targets, loss = mean</span>}
        >
          <Suspense fallback={<ChartSkeleton />}>
            <LatencyChart series={SAMPLE_SPIKE_SERIES} range="1h" />
          </Suspense>
        </Panel>
      </Specimen>

      <div className="flex flex-col gap-4">
        <Specimen
          label="Table twin"
          note="Every value the chart draws, as a real table, so no value is reachable only through a tooltip."
        >
          <ChartTable table={table} heightRem={PLOT_REM} />
        </Specimen>
        <Specimen
          label="Loading frame"
          bare
          note="Ghost axes at the real grid positions and one skeleton line, so the frame never moves."
        >
          <Panel
            title="Network latency, loading"
            features="network"
            scope="1h"
            refreshMs={POLL_MS}
            status="loading"
            skeleton={<ChartSkeleton />}
            flush
            bodyClassName="px-3 py-2"
          />
        </Specimen>
      </div>

      <Specimen
        label="Second chart, same frame"
        bare
        note="A new monitoring chart supplies only its series and axes. The legend, the shared crosshair and tooltip, the keyboard cursor, the Table twin and the v key all come from the frame, so every chart answers the same hands the same way. One grid here, two measures of one unit; the plot grows with its panel."
      >
        <Panel
          title="Interface traffic"
          features="snmp"
          plannedNote="The console does not read interface counters yet."
          scope="30m"
          refreshMs={POLL_MS}
          flush
          bodyClassName="flex flex-col px-3 py-2"
          footer={<span className="truncate">in and out of one interface, 1-minute samples</span>}
        >
          <Suspense
            fallback={
              <div className="min-h-47 flex-1">
                <Skeleton className="h-full" />
              </div>
            }
          >
            <BandwidthChart />
          </Suspense>
        </Panel>
      </Specimen>
    </div>
  )
}
