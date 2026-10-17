import { Link, useLocation } from 'react-router'
import type { DeviceListItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import {
  DEVICE_TYPE_LABEL,
  deviceReasonSentence,
  deviceReasonWord,
  interfaceCountsSpoken,
  interfaceCountsText,
  isCurrentDevice,
  polledAgo,
  snmpText,
} from '@/lib/devices'
import { PlaceName } from '@/ui/PlaceName'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { devicePath, responseCell } from './snmpModel'

/**
 * The same list for a phone: one card per device, still a list of links. Name and status lead, then
 * what it is and where, the interfaces, and the response time or the reason there is none.
 */
export function SnmpCards({ rows, nowMs }: { rows: readonly DeviceListItem[]; nowMs: number }) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="SNMP devices" className="min-h-0 flex-1 overflow-auto">
      {rows.map((item) => {
        const { device } = item
        const response = responseCell(item)
        return (
          <li key={device.id} className="relative border-b border-border last:border-b-0">
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.health])}
            />
            <Link
              to={viewTo(devicePath(device.id))}
              state={{ list: location.search }}
              className="flex flex-col gap-1.5 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
            >
              <span className="flex items-center gap-2">
                <StatusTag
                  status={item.health}
                  word={deviceReasonWord(item.reason)}
                  variant="tag"
                />
                <span className="type-data-strong min-w-0 flex-1 truncate">{device.name}</span>
                <span className="type-data tnum shrink-0 text-fg-faint">
                  {polledAgo(item, nowMs)}
                </span>
              </span>
              <span className="type-data flex min-w-0 items-center gap-2 text-fg-faint">
                <span className="min-w-0 flex-1 truncate">
                  {DEVICE_TYPE_LABEL[device.type]} · {device.address} · {snmpText(item)}
                </span>
                <span
                  className="shrink-0"
                  aria-label={`interfaces: ${interfaceCountsSpoken(item)}`}
                >
                  if {interfaceCountsText(item)}
                </span>
              </span>
              {item.siteName && item.customerName ? (
                <PlaceName
                  customer={item.customerName}
                  site={item.siteName}
                  className="type-body min-w-0"
                />
              ) : null}
              {isCurrentDevice(item) && item.reason === 'ok' ? (
                <span className="type-data tnum">{response.text}</span>
              ) : (
                <span className="type-body text-fg-muted">{deviceReasonSentence(item, nowMs)}</span>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
