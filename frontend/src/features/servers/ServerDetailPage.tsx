import { ArrowLeft } from 'lucide-react'
import { Link, useLocation, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { ServerListItem } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { useViewSearch } from '@/app/viewSearch'
import { useLiveResource } from '@/hooks/useLiveResource'
import { cn } from '@/lib/cn'
import { formatTime } from '@/lib/format'
import { PlaceName } from '@/ui/PlaceName'
import { PanelBoundary } from '@/ui/PanelBoundary'
import { EmptyState, Skeleton } from '@/ui/states'
import { STATUS_FRAME, STATUS_TINT, StatusTag } from '@/ui/status'
import { ContainersPanel } from './ContainersPanel'
import { HistoryPanel } from './HistoryPanel'
import { stateWord, heartbeatText } from './serversModel'
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

/** The offline / never-reported notice: the one thing to know before reading any number below. */
function ReportingNotice({ item, nowMs }: { item: ServerListItem; nowMs: number }) {
  const { tz } = usePrefs()
  const { server } = item
  if (server.status === 'offline' && server.lastSeenAt) {
    const at = `${formatTime(Date.parse(server.lastSeenAt), tz)}${tz === 'utc' ? 'Z' : ''}`
    return (
      <output
        className={cn(
          'type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-3 py-2',
          STATUS_FRAME.critical,
          STATUS_TINT.critical,
        )}
      >
        <StatusTag status="critical" word="OFFLINE" />
        <span>
          The agent stopped reporting at {at} ({heartbeatText(item, nowMs)}). Readings below are the
          last it sent, and its containers cannot be observed.
        </span>
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
 * One server: who it is, how it is doing now, how it got there (CPU, RAM and
 * disk over the range in the top bar) and what runs on it (Docker). Mock data
 * until the backend has a read API.
 */
export default function ServerDetailPage() {
  const api = useApi()
  const { id = '' } = useParams()
  const back = useBackTo()
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

  const hostOffline = item?.server.status === 'offline'

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
          {item ? <StatusTag status={item.health} word={stateWord(item)} variant="tag" /> : null}
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
        <PanelBoundary title="Summary" index={1} features="servers" className="lg:col-span-12">
          <SummaryPanel
            item={item}
            nowMs={nowMs}
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
            serverId={id}
            name={item?.server.name ?? id}
            className="lg:col-span-7"
          />
        </PanelBoundary>
        <PanelBoundary title="Containers" index={3} features="docker" className="lg:col-span-5">
          <ContainersPanel
            index={3}
            resource={resource}
            hostOffline={hostOffline}
            className="lg:col-span-5"
          />
        </PanelBoundary>
      </div>
    </div>
  )
}
