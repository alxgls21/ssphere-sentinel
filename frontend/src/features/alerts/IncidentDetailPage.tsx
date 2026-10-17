import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { IncidentDetail } from '@/api/types'
import { useAlerts } from '@/app/alerts'
import { useViewSearch } from '@/app/viewSearch'
import { useLiveResource } from '@/hooks/useLiveResource'
import { KIND_LABEL, isOpen } from '@/lib/incidents'
import { IncidentStatusTag, SeverityTag } from '@/ui/incidents'
import { PanelBoundary } from '@/ui/PanelBoundary'
import { PlaceName } from '@/ui/PlaceName'
import { EmptyState, Skeleton } from '@/ui/states'
import { AckNoticeLine, AcknowledgeButton } from './AcknowledgeControls'
import { useAcknowledge } from './acknowledge'
import { IncidentSummaryPanel, IncidentTimelinePanel } from './IncidentPanels'

function useBackTo() {
  const view = useViewSearch()
  const location = useLocation()
  // Back to the list as it was left (search, filters, sort, page), not as it would be by default.
  const list = (location.state as { list?: string } | null)?.list
  return { pathname: '/alerts', search: list ?? view }
}

function NotFound({ id }: { id: string }) {
  const back = useBackTo()
  return (
    <div className="rounded-sm border border-border bg-panel">
      <EmptyState
        title="Incident not found"
        hint={
          <>
            No incident <code className="type-data text-fg">{id}</code> is visible to you. It may
            not exist, or it belongs to a customer or site outside your access.{' '}
            <Link to={back} className="text-primary underline underline-offset-2">
              Back to Alerts
            </Link>
          </>
        }
      />
    </div>
  )
}

/**
 * One incident: the object, the rule and its condition, the times, who saw it and how it ended, and
 * its recorded timeline. Everything is read from the console API. The Acknowledge action is offered
 * only where the API says this user may use it, and the incident shown after it is the API's
 * answer: nothing here marks an incident acknowledged on its own, or resolves one.
 */
export default function IncidentDetailPage() {
  const api = useApi()
  const { id = '' } = useParams()
  const back = useBackTo()
  const alerts = useAlerts()
  const resource = useLiveResource(
    `incident:${id}`,
    `incident:${id}`,
    (signal) => api.getIncident(id, { signal }),
    { keepPreviousData: false },
  )
  // The answer to an acknowledgement is the incident as it now is: shown at once, replaced by any later poll.
  const [answered, setAnswered] = useState<IncidentDetail | null>(null)
  const ack = useAcknowledge({
    onSettled: (detail) => {
      if (detail) setAnswered(detail)
      resource.refetch()
      alerts?.overview.refetch()
    },
  })

  const polled = resource.data
  const detail =
    answered && answered.item.id === id && (!polled || answered.generatedAt >= polled.generatedAt)
      ? answered
      : polled
  const item = detail?.item

  if (resource.error instanceof ApiError && resource.error.status === 404 && !detail) {
    return <NotFound id={id} />
  }

  const data = {
    status: detail ? ('success' as const) : resource.status,
    error: resource.error,
    updatedAt: resource.updatedAt,
    onRetry: resource.refetch,
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-col gap-1">
        <Link
          to={back}
          className="type-data inline-flex w-fit items-center gap-1 rounded-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          Alerts
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="type-title">
            {item ? (
              item.entity.label
            ) : resource.error ? (
              'Incident'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h1>
          {item ? (
            <>
              <SeverityTag severity={item.severity} />
              <IncidentStatusTag status={item.status} />
              <span className="type-tag text-fg-muted">
                {isOpen(item.status) ? 'OPEN' : 'ENDED'}
              </span>
            </>
          ) : null}
          {item?.canAcknowledge ? (
            <span className="ml-auto">
              <AcknowledgeButton
                label={item.entity.label}
                busy={ack.busy === item.id}
                onAcknowledge={() => void ack.acknowledge(item.id)}
              />
            </span>
          ) : null}
        </div>
        {item ? (
          <p className="type-data flex flex-wrap items-center gap-x-3 gap-y-0.5 text-fg-muted">
            <span>{KIND_LABEL[item.entity.kind]}</span>
            <span>{item.rule.name}</span>
            {item.siteName && item.customerName ? (
              <PlaceName customer={item.customerName} site={item.siteName} className="type-body" />
            ) : null}
          </p>
        ) : null}
      </header>

      <AckNoticeLine notice={ack.notice} onDismiss={ack.dismiss} />
      {item && item.status === 'active' && !item.canAcknowledge ? (
        <p className="type-body rounded-sm border border-border bg-raised px-3 py-2 text-fg-muted">
          This incident is active and not yet acknowledged. Acknowledging needs a permission this
          account does not have.
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-12">
        <PanelBoundary title="Summary" index={1} features="alerts" className="lg:col-span-12">
          <IncidentSummaryPanel detail={detail} className="lg:col-span-12" {...data} />
        </PanelBoundary>
        <PanelBoundary title="Timeline" index={2} features="alerts" className="lg:col-span-12">
          <IncidentTimelinePanel detail={detail} className="lg:col-span-12" {...data} />
        </PanelBoundary>
      </div>
    </div>
  )
}
