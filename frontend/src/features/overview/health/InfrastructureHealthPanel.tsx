import { useMemo } from 'react'
import { Link } from 'react-router'
import { useApi } from '@/api/context'
import type { HealthStatus } from '@/api/types'
import { useLive } from '@/app/live'
import { scopeKey, useScope } from '@/app/viewState'
import type { FeatureId } from '@/config/features'
import { useLiveResource } from '@/hooks/useLiveResource'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { DomainRows } from './DomainRows'
import { SiteSection } from './SiteRows'
import { SITE_ROWS, isHealthEmpty, rankedSites } from './healthModel'
import { useViewTo } from '@/app/viewSearch'

/**
 * Every feature this panel draws on. It is only PLANNED when all of them are,
 * so it stays solid: the SNMP row and BY SITE carry their own planned marks.
 */
const FEATURES_USED: readonly FeatureId[] = ['servers', 'docker', 'network', 'snmp', 'site-links']

const LEGEND: readonly HealthStatus[] = ['healthy', 'warning', 'critical', 'unknown', 'idle']

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

function StatusLegend() {
  return (
    <ul aria-label="Status legend" className="flex flex-wrap items-center gap-x-3">
      {LEGEND.map((status) => (
        <li key={status}>
          <StatusTag status={status} />
        </li>
      ))}
    </ul>
  )
}

/**
 * [4] Infrastructure health: composition of each monitored domain, then the
 * worst sites. Mock data until the backend has a read API; the SNMP row and
 * BY SITE are PLANNED sub-elements (nothing collects SNMP, nothing links
 * servers or targets to a site).
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
  const hidden = sites.length - SITE_ROWS

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
          hint="No server, container or network target in this scope has reported."
        />
      }
      skeleton={<HealthSkeleton />}
      footer={
        <>
          <StatusLegend />
          {hidden > 0 ? (
            <Link
              to={viewTo('/customers')}
              className="ml-auto whitespace-nowrap text-primary hover:text-primary-hover"
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
          <SiteSection sites={sites.slice(0, SITE_ROWS)} />
        </>
      ) : null}
    </Panel>
  )
}
