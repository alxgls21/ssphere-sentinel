import { ArrowLeft } from 'lucide-react'
import { Link, useLocation, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { TargetDetail, TargetListItem } from '@/api/types'
import { useViewSearch } from '@/app/viewSearch'
import { useRange } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import type { Resource } from '@/hooks/useResource'
import {
  endpointText,
  isCurrent,
  protocolText,
  reasonSentence,
  reasonWord,
  type TargetLimits,
} from '@/lib/targets'
import { PlaceName } from '@/ui/PlaceName'
import { PanelBoundary } from '@/ui/PanelBoundary'
import { EmptyState, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { AvailabilityPanel, MeasurementsPanel, TargetSummaryPanel } from './TargetPanels'
import { TargetHistoryPanel } from './TargetHistoryPanel'
import { useTargetLimits } from './useTargetLimits'

function useBackTo() {
  const view = useViewSearch()
  const location = useLocation()
  // Back to the list as it was left (search, filter, sort), not as it would be by default.
  const list = (location.state as { list?: string } | null)?.list
  return { pathname: '/network', search: list ?? view }
}

function NotFound({ id }: { id: string }) {
  const back = useBackTo()
  return (
    <div className="rounded-sm border border-border bg-panel">
      <EmptyState
        title="Target not found"
        hint={
          <>
            Nothing is monitored under <code className="type-data text-fg">{id}</code>. It may have
            been removed, or it is outside the current scope.{' '}
            <Link to={back} className="text-primary underline underline-offset-2">
              Back to Network
            </Link>
          </>
        }
      />
    </div>
  )
}

/**
 * The one thing to know before reading any number below, for a target with no current reading:
 * switched off, no agent, an agent that is not reporting, nothing measured, or a measurement too
 * old to describe the present. Failing and slow targets are described in the Summary instead.
 */
function ReadingNotice({
  item,
  nowMs,
  limits,
}: {
  item: TargetListItem
  nowMs: number
  limits: TargetLimits
}) {
  if (isCurrent(item)) return null
  return (
    <output className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border bg-raised px-3 py-2">
      <StatusTag status={item.health} word={reasonWord(item.reason, item.target.protocol)} />
      <span>{reasonSentence(item, nowMs, limits)}</span>
    </output>
  )
}

/**
 * Summary, history, availability and recent measurements of one target. The history is requested
 * here, keyed by target, so the series kept on screen while a range loads is never another
 * target's.
 */
function TargetPanels({
  id,
  resource,
  limits,
}: {
  id: string
  resource: Resource<TargetDetail>
  limits: TargetLimits
}) {
  const api = useApi()
  const [range] = useRange()
  const history = useLiveResource(
    `target-history:${id}`,
    `target-series:${id}:${range}`,
    (signal) => api.getTargetSeries({ targetId: id, range, signal }),
    // Changing the range keeps the chart on screen, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  const detail = resource.data
  const item = detail?.item
  const nowMs = detail ? Date.parse(detail.generatedAt) : 0
  const data = {
    status: resource.status,
    error: resource.error,
    updatedAt: resource.updatedAt,
    onRetry: resource.refetch,
  }

  return (
    <>
      <PanelBoundary title="Summary" index={1} features="network" className="lg:col-span-12">
        <TargetSummaryPanel
          item={item}
          nowMs={nowMs}
          limits={limits}
          className="lg:col-span-12"
          {...data}
        />
      </PanelBoundary>
      <PanelBoundary title="History" index={2} features="network" className="lg:col-span-7">
        <TargetHistoryPanel
          index={2}
          resource={history}
          name={item?.target.name ?? id}
          protocol={item?.target.protocol ?? 'icmp'}
          limits={limits}
          className="lg:col-span-7"
        />
      </PanelBoundary>
      <div className="contents lg:col-span-5 lg:flex lg:min-h-0 lg:flex-col lg:gap-3">
        <PanelBoundary title="Observed availability" index={3} features="network">
          <AvailabilityPanel availability={detail?.availability24h} {...data} />
        </PanelBoundary>
        <PanelBoundary
          title="Recent measurements"
          index={4}
          features="network"
          className="lg:min-h-0 lg:flex-1"
        >
          <MeasurementsPanel detail={detail} className="lg:min-h-0 lg:flex-1" {...data} />
        </PanelBoundary>
      </div>
    </>
  )
}

/**
 * One target: what it is and how it is configured, which agent measures it, its health and why,
 * its newest measurement, what the last 24 hours observed and its history over the range in the
 * top bar. All of it is read from the console API; a failed request is its panel's error, never
 * sample data.
 */
export default function TargetDetailPage() {
  const api = useApi()
  const { id = '' } = useParams()
  const back = useBackTo()
  const limits = useTargetLimits()
  const resource = useLiveResource(
    `target:${id}`,
    `target:${id}`,
    (signal) => api.getTarget(id, { signal }),
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
          Network
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="type-title">
            {item ? (
              item.target.name
            ) : resource.error ? (
              'Target'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h1>
          {item ? (
            <StatusTag
              status={item.health}
              word={reasonWord(item.reason, item.target.protocol)}
              variant="tag"
            />
          ) : null}
        </div>
        {item ? (
          <p className="type-data flex flex-wrap items-center gap-x-3 gap-y-0.5 text-fg-muted">
            <span>{protocolText(item)}</span>
            <span>{endpointText(item)}</span>
            {item.siteName && item.customerName ? (
              <PlaceName customer={item.customerName} site={item.siteName} className="type-body" />
            ) : null}
          </p>
        ) : null}
      </header>

      {item ? <ReadingNotice item={item} nowMs={nowMs} limits={limits} /> : null}

      <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-12 lg:grid-rows-[auto_minmax(20.375rem,1fr)]">
        <TargetPanels key={id} id={id} resource={resource} limits={limits} />
      </div>
    </div>
  )
}
