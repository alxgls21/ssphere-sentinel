import { ArrowLeft } from 'lucide-react'
import { Link, useLocation, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { ServerDetail, ServerListItem } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { useViewSearch } from '@/app/viewSearch'
import { useRange } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import type { Resource } from '@/hooks/useResource'
import { useStale } from '@/hooks/useStale'
import { cn } from '@/lib/cn'
import { formatAge, formatClock } from '@/lib/format'
import { PlaceName } from '@/ui/PlaceName'
import { PanelBoundary } from '@/ui/PanelBoundary'
import { EmptyState, Skeleton } from '@/ui/states'
import { STATUS_FRAME, STATUS_TINT, StatusTag } from '@/ui/status'
import { ContainersPanel } from './ContainersPanel'
import { HistoryPanel } from './HistoryPanel'
import { readingOf } from '@/lib/serverList'
import { useResourceLimits } from '@/ui/meters'
import { stateWord, heartbeatText, serverDisplay } from './serversModel'
import { SummaryPanel } from './SummaryPanel'

function useBackTo() {
  const view = useViewSearch()
  const location = useLocation()
  // Back to the list as it was left (search, filter, sort), not as it would be by default.
  const list = (location.state as { list?: string } | null)?.list
  return { pathname: '/servers', search: list ?? view }
}

function NotFound({ id }: { id: string }) {
  const back = useBackTo()
  return (
    <div className="rounded-sm border border-border bg-panel">
      <EmptyState
        title="Server not found"
        hint={
          <>
            Nothing is monitored under <code className="type-data text-fg">{id}</code>. It may have
            been removed, or it is outside the current scope.{' '}
            <Link to={back} className="text-primary underline underline-offset-2">
              Back to Servers
            </Link>
          </>
        }
      />
    </div>
  )
}

/** The offline, stale, missing or never-reported notice: the one thing to know before reading any number below. */
function ReportingNotice({ item, nowMs }: { item: ServerListItem; nowMs: number }) {
  const { tz } = usePrefs()
  const { server } = item
  if (server.status === 'offline' && server.lastSeenAt) {
    const at = formatClock(Date.parse(server.lastSeenAt), tz)
    return (
      <output
        className={cn(
          'type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-3 py-2',
          STATUS_FRAME.offline,
          STATUS_TINT.offline,
        )}
      >
        <StatusTag status="offline" word="OFFLINE" />
        <span>
          The agent stopped reporting at {at} ({heartbeatText(item, nowMs)}). Readings below are the
          last it sent, and its containers cannot be observed.
        </span>
      </output>
    )
  }
  const reading = readingOf(item)
  if (reading === 'stale' && server.telemetry) {
    const received = server.telemetry.receivedAt ?? server.telemetry.collectedAt
    return (
      <output className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border bg-raised px-3 py-2">
        <StatusTag status="unknown" word="STALE" />
        <span>
          The agent still sends heartbeats, but its newest resource reading arrived at{' '}
          {formatClock(Date.parse(received), tz)} ({formatAge(received, nowMs)} ago), older than the
          offline window. Readings below are the last received, not the present values, and they
          take no part in this server's health.
        </span>
      </output>
    )
  }
  if (reading === 'missing') {
    return (
      <output className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border bg-raised px-3 py-2">
        <StatusTag status="unknown" word="NO READING" />
        <span>The agent reports, but no resource reading has arrived yet.</span>
      </output>
    )
  }
  if (server.status === 'unknown') {
    return (
      <output className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border bg-raised px-3 py-2">
        <StatusTag status="unknown" word="UNKNOWN" />
        <span>This server is enrolled but has never reported: there is nothing to show yet.</span>
      </output>
    )
  }
  return null
}

/**
 * Summary, history and containers of one server. The history is requested once
 * here, for the Summary's sparklines and the history chart alike. The page keys
 * this by server, so the series kept on screen while a range loads is never
 * another server's.
 */
function ServerPanels({ id, resource }: { id: string; resource: Resource<ServerDetail> }) {
  const api = useApi()
  const [range] = useRange()
  const history = useLiveResource(
    `server-history:${id}`,
    `server-series:${id}:${range}`,
    (signal) => api.getServerSeries({ serverId: id, range, signal }),
    // Changing the range keeps the chart on screen, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  // The sparklines in the Summary and the history panel share one series; only the panel has a banner for it.
  const historyStale = useStale(history.updatedAt) || history.error !== null
  const item = resource.data?.item
  const nowMs = resource.data ? Date.parse(resource.data.generatedAt) : 0

  return (
    <>
      <PanelBoundary title="Summary" index={1} features="servers" className="lg:col-span-12">
        <SummaryPanel
          item={item}
          nowMs={nowMs}
          series={history.data}
          seriesStale={historyStale}
          className="lg:col-span-12"
          status={resource.status}
          error={resource.error}
          updatedAt={resource.updatedAt}
          onRetry={resource.refetch}
        />
      </PanelBoundary>
      <PanelBoundary
        title="Resource history"
        index={2}
        features="servers"
        className="lg:col-span-7"
      >
        <HistoryPanel
          index={2}
          resource={history}
          name={item?.server.name ?? id}
          className="lg:col-span-7"
        />
      </PanelBoundary>
      <PanelBoundary title="Containers" index={3} features="servers" className="lg:col-span-5">
        <ContainersPanel
          index={3}
          resource={resource}
          hostOffline={item?.server.status === 'offline'}
          className="lg:col-span-5"
        />
      </PanelBoundary>
    </>
  )
}

/**
 * One server: who it is, how it is doing now, how it got there (CPU, RAM and
 * disk over the range in the top bar) and what runs on it (Docker). All of it is
 * read from the console API; a failed request is its panel's error, never sample data.
 */
export default function ServerDetailPage() {
  const api = useApi()
  const { id = '' } = useParams()
  const back = useBackTo()
  const limits = useResourceLimits()
  const resource = useLiveResource(
    `server:${id}`,
    `server:${id}`,
    (signal) => api.getServer(id, { signal }),
    { keepPreviousData: false },
  )
  const detail = resource.data
  const item = detail?.item
  const nowMs = detail ? Date.parse(detail.generatedAt) : 0

  if (resource.error instanceof ApiError && resource.error.status === 404 && !detail) {
    return <NotFound id={id} />
  }

  return (
    <div className="flex min-h-full flex-col gap-3 lg:h-full lg:min-h-[34rem]">
      <header className="flex flex-col gap-1">
        <Link
          to={back}
          className="type-data inline-flex w-fit items-center gap-1 rounded-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          Servers
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="type-title">
            {item ? (
              item.server.name
            ) : resource.error ? (
              'Server'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h1>
          {item ? (
            <StatusTag status={serverDisplay(item)} word={stateWord(item, limits)} variant="tag" />
          ) : null}
        </div>
        {item ? (
          <p className="type-data flex flex-wrap items-center gap-x-3 gap-y-0.5 text-fg-muted">
            <span>{item.server.hostname}</span>
            {item.server.ipAddress ? <span>{item.server.ipAddress}</span> : null}
            <span>{item.server.operatingSystem}</span>
            {item.siteName && item.customerName ? (
              <PlaceName customer={item.customerName} site={item.siteName} className="type-body" />
            ) : null}
          </p>
        ) : null}
      </header>

      {item ? <ReportingNotice item={item} nowMs={nowMs} /> : null}

      <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-12 lg:grid-rows-[auto_minmax(20.375rem,1fr)]">
        <ServerPanels key={id} id={id} resource={resource} />
      </div>
    </div>
  )
}
