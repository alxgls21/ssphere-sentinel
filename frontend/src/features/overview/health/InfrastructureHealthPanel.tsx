import { useMemo } from 'react'
import { Link } from 'react-router'
import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { scopeKey, useScope } from '@/app/viewState'
import type { FeatureId } from '@/config/features'
import { useLiveResource } from '@/hooks/useLiveResource'
import { cn } from '@/lib/cn'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { StatusLegend } from '@/ui/status'
import { DomainRows } from './DomainRows'
import { SiteSection } from './SiteRows'
import { SITE_ROWS, isHealthEmpty, legendStates, rankedSites } from './healthModel'
import { useViewTo } from '@/app/viewSearch'

/**
 * What this panel's figures come from: the overview counts of servers, containers, probe targets
 * and SNMP devices, and the site each is placed on.
 */
const FEATURES_USED: readonly FeatureId[] = ['overview', 'network', 'snmp', 'site-links']

/**
 * The legend shares the 28px footer with the "more sites" link. Its rows are 12px
 * tall, so two fit without growing the footer: from five states it wraps at three
 * marks a row (11rem holds three marks with their words, never four) until the
 * panel is wide enough for one line beside the link.
 */
const STACKED_FROM = 5
const STACKED_LEGEND = 'max-w-44 @min-[30rem]:max-w-none'

/** Placeholder rows at the real row height: four domains, then three sites. */
function HealthSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 4 + SITE_ROWS }, (_, index) => (
        <div key={index} className="flex h-(--row-h) items-center">
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * [4] Infrastructure health: composition of each monitored domain, then the
 * worst sites. Every row and BY SITE are the console API's counts. The SNMP row counts devices
 * by their own health; its tooltip also gives their interfaces, labelled partial when the rows
 * hold only some of the scope's devices.
 */
export function InfrastructureHealthPanel({ className }: { className?: string }) {
  const viewTo = useViewTo()
  const api = useApi()
  const { pollMs } = useLive()
  const [scope] = useScope()

  const { status, data, error, isRefreshing, updatedAt, refetch } = useLiveResource(
    'health',
    `health:${scopeKey(scope)}`,
    (signal) => api.getHealthBreakdown({ scope, signal }),
    // A scope change keeps the previous render, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )

  const sites = useMemo(() => (data ? rankedSites(data.sites) : []), [data])
  const listed = useMemo(() => sites.slice(0, SITE_ROWS), [sites])
  const hidden = sites.length - SITE_ROWS
  const legend = useMemo(() => legendStates(data?.domains ?? [], listed), [data, listed])

  return (
    <Panel
      index={4}
      title="Infrastructure health"
      features={FEATURES_USED}
      className={className}
      refreshMs={pollMs}
      status={status}
      refreshing={isRefreshing}
      error={error}
      updatedAt={updatedAt}
      onRetry={refetch}
      isEmpty={data ? isHealthEmpty(data.domains) : false}
      empty={
        <EmptyState
          title="Nothing monitored yet"
          hint="No server, container, probe target or SNMP device in this scope has reported."
        />
      }
      skeleton={<HealthSkeleton />}
      footer={
        <>
          <StatusLegend
            statuses={legend}
            className={cn('min-w-0 leading-3', legend.length >= STACKED_FROM && STACKED_LEGEND)}
          />
          {hidden > 0 ? (
            <Link
              to={viewTo('/customers')}
              className="ml-auto shrink-0 whitespace-nowrap text-primary hover:text-primary-hover"
            >
              +{hidden} more {hidden === 1 ? 'site' : 'sites'}
            </Link>
          ) : null}
        </>
      }
    >
      {data ? (
        <>
          <DomainRows domains={data.domains} />
          <SiteSection sites={listed} coverage={data.siteCoverage} />
        </>
      ) : null}
    </Panel>
  )
}
