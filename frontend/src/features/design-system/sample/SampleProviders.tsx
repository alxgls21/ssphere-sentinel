import { useContext, useMemo, type ReactNode } from 'react'
import { ApiContext } from '@/api/context'
import type { OverviewSummary } from '@/api/types'
import { LiveContext } from '@/app/live'
import { PrefsContext } from '@/app/prefs'
import { ShellContext } from '@/app/shell'
import { SummaryContext } from '@/app/summary'
import { SAMPLE_SUMMARIES } from './data'
import {
  FALLBACK_PREFS,
  GALLERY_API,
  GALLERY_SHELL,
  liveControls,
  summaryResource,
  type ScenarioKind,
} from './scenario'

interface SummaryScenarioProps {
  kind?: ScenarioKind
  summary?: OverviewSummary
  children: ReactNode
}

/**
 * The live layer and the shared summary, in one fixed state. Wrap a component
 * that reads them (the verdict, the tiles) to show it in that state; each
 * scenario owns its freshness store, so one cannot age another.
 */
export function SummaryScenario({
  kind = 'ready',
  summary = SAMPLE_SUMMARIES.critical,
  children,
}: SummaryScenarioProps) {
  const live = useMemo(() => liveControls(kind), [kind])
  const resource = useMemo(() => summaryResource(kind, summary), [kind, summary])
  return (
    <LiveContext.Provider value={live}>
      <SummaryContext.Provider value={resource}>{children}</SummaryContext.Provider>
    </LiveContext.Provider>
  )
}

/** The app's preferences when there are any; a fixed set when the page stands alone. */
function PrefsFallback({ children }: { children: ReactNode }) {
  const ambient = useContext(PrefsContext)
  return ambient ? (
    children
  ) : (
    <PrefsContext.Provider value={FALLBACK_PREFS}>{children}</PrefsContext.Provider>
  )
}

/**
 * Everything a shared component may read from context, from static values, so
 * the gallery never depends on a data source and always labels itself mock.
 * Needs a router above it (tiles are links, the alerts tile reads the scope).
 */
export function GalleryProviders({ children }: { children: ReactNode }) {
  return (
    <ApiContext.Provider value={GALLERY_API}>
      <PrefsFallback>
        <ShellContext.Provider value={GALLERY_SHELL}>
          <SummaryScenario>{children}</SummaryScenario>
        </ShellContext.Provider>
      </PrefsFallback>
    </ApiContext.Provider>
  )
}
