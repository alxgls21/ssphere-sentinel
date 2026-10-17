import { ArrowLeft } from 'lucide-react'
import { useCallback } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { DeviceDetail, DeviceListItem } from '@/api/types'
import { useViewSearch } from '@/app/viewSearch'
import { useRange } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import type { Resource } from '@/hooks/useResource'
import {
  DEVICE_TYPE_LABEL,
  deviceReasonSentence,
  deviceReasonWord,
  isCurrentDevice,
  snmpText,
} from '@/lib/devices'
import { PlaceName } from '@/ui/PlaceName'
import { PanelBoundary } from '@/ui/PanelBoundary'
import { EmptyState, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { DeviceSummaryPanel, InterfacesPanel, PollsPanel } from './DevicePanels'
import { DeviceHistoryPanel, InterfaceHistoryPanel } from './HistoryPanels'

/** The interface shown in the history panel lives in the URL, so a reload and a shared link show it. */
const INTERFACE_PARAM = 'interface'

function useBackTo() {
  const view = useViewSearch()
  const location = useLocation()
  // Back to the list as it was left (search, filter, sort), not as it would be by default.
  const list = (location.state as { list?: string } | null)?.list
  return { pathname: '/snmp', search: list ?? view }
}

function NotFound({ id }: { id: string }) {
  const back = useBackTo()
  return (
    <div className="rounded-sm border border-border bg-panel">
      <EmptyState
        title="Device not found"
        hint={
          <>
            Nothing is monitored under <code className="type-data text-fg">{id}</code>. It may have
            been removed, or it is outside the current scope.{' '}
            <Link to={back} className="text-primary underline underline-offset-2">
              Back to SNMP
            </Link>
          </>
        }
      />
    </div>
  )
}

/**
 * The one thing to know before reading any figure, for a device with no current poll: switched
 * off, no agent, an agent that is not reporting, never polled, or a poll too old to describe the
 * present. An unreachable device is described in the Summary instead.
 */
function StateNotice({ item, nowMs }: { item: DeviceListItem; nowMs: number }) {
  if (isCurrentDevice(item)) return null
  return (
    <output className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border bg-raised px-3 py-2">
      <StatusTag status={item.health} word={deviceReasonWord(item.reason)} />
      <span>{deviceReasonSentence(item, nowMs)}</span>
    </output>
  )
}

/** The interface history, or why there is none to show, for the interface the URL names. */
function SelectedInterface({
  detail,
  ifIndex,
}: {
  detail: DeviceDetail | undefined
  ifIndex: number
}) {
  const iface = detail?.interfaces.find((candidate) => candidate.ifIndex === ifIndex)
  if (!detail) return null
  if (!iface) {
    return (
      <div className="rounded-sm border border-border bg-panel">
        <EmptyState
          title="Interface not listed"
          hint={`This device lists no present interface with ifIndex ${ifIndex}.`}
        />
      </div>
    )
  }
  return (
    <PanelBoundary title="Interface history" index={5} features="snmp" className="lg:col-span-12">
      <InterfaceHistoryPanel
        key={iface.ifIndex}
        deviceId={detail.item.device.id}
        iface={iface}
        className="lg:col-span-12"
      />
    </PanelBoundary>
  )
}

/**
 * Summary, poll history, recent polls, interfaces and the history of the chosen interface. The
 * history is requested here, keyed by device, so the series kept on screen while a range loads is
 * never another device's.
 */
function DevicePanels({ id, resource }: { id: string; resource: Resource<DeviceDetail> }) {
  const api = useApi()
  const [range] = useRange()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const history = useLiveResource(
    `device-history:${id}`,
    `device-series:${id}:${range}`,
    (signal) => api.getDeviceSeries({ deviceId: id, range, signal }),
    // Changing the range keeps the chart on screen, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  const detail = resource.data
  const item = detail?.item
  const nowMs = detail ? Date.parse(detail.generatedAt) : 0
  const raw = params.get(INTERFACE_PARAM)
  const selected = raw !== null && /^\d{1,10}$/.test(raw) ? Number(raw) : null
  const select = useCallback(
    (ifIndex: number | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (ifIndex === null) next.delete(INTERFACE_PARAM)
          else next.set(INTERFACE_PARAM, String(ifIndex))
          return next
        },
        // The note of where the list was left stays with the entry, so Back still finds it as it was.
        { replace: true, state: location.state },
      ),
    [setParams, location.state],
  )
  const data = {
    status: resource.status,
    error: resource.error,
    updatedAt: resource.updatedAt,
    onRetry: resource.refetch,
  }

  return (
    <>
      <PanelBoundary title="Summary" index={1} features="snmp" className="lg:col-span-12">
        <DeviceSummaryPanel item={item} nowMs={nowMs} className="lg:col-span-12" {...data} />
      </PanelBoundary>
      <PanelBoundary title="Poll history" index={2} features="snmp" className="lg:col-span-7">
        <DeviceHistoryPanel
          resource={history}
          name={item?.device.name ?? id}
          className="lg:col-span-7"
        />
      </PanelBoundary>
      <PanelBoundary title="Recent polls" index={3} features="snmp" className="lg:col-span-5">
        <PollsPanel detail={detail} className="lg:col-span-5" {...data} />
      </PanelBoundary>
      <PanelBoundary title="Interfaces" index={4} features="snmp" className="lg:col-span-12">
        <InterfacesPanel
          detail={detail}
          nowMs={nowMs}
          selected={selected}
          onSelect={select}
          className="lg:col-span-12"
          {...data}
        />
      </PanelBoundary>
      {selected !== null ? <SelectedInterface detail={detail} ifIndex={selected} /> : null}
    </>
  )
}

/**
 * One SNMP device: what it is and how it is polled, which agent polls it, its health and why, its
 * latest poll, its history over the range in the top bar, and its interfaces with the history of
 * the one chosen. All of it is read from the console API; a failed request is its panel's error,
 * never sample data, and no credential is ever read.
 */
export default function DeviceDetailPage() {
  const api = useApi()
  const { id = '' } = useParams()
  const back = useBackTo()
  const resource = useLiveResource(
    `device:${id}`,
    `device:${id}`,
    (signal) => api.getDevice(id, { signal }),
    { keepPreviousData: false },
  )
  const detail = resource.data
  const item = detail?.item
  const nowMs = detail ? Date.parse(detail.generatedAt) : 0

  if (resource.error instanceof ApiError && resource.error.status === 404 && !detail) {
    return <NotFound id={id} />
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-col gap-1">
        <Link
          to={back}
          className="type-data inline-flex w-fit items-center gap-1 rounded-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          SNMP
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="type-title">
            {item ? (
              item.device.name
            ) : resource.error ? (
              'Device'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h1>
          {item ? (
            <StatusTag status={item.health} word={deviceReasonWord(item.reason)} variant="tag" />
          ) : null}
        </div>
        {item ? (
          <p className="type-data flex flex-wrap items-center gap-x-3 gap-y-0.5 text-fg-muted">
            <span>{DEVICE_TYPE_LABEL[item.device.type]}</span>
            <span>{item.device.address}</span>
            <span>{snmpText(item)}</span>
            {item.siteName && item.customerName ? (
              <PlaceName customer={item.customerName} site={item.siteName} className="type-body" />
            ) : null}
          </p>
        ) : null}
      </header>

      {item ? <StateNotice item={item} nowMs={nowMs} /> : null}

      <div className="grid gap-3 lg:grid-cols-12">
        <DevicePanels key={id} id={id} resource={resource} />
      </div>
    </div>
  )
}
