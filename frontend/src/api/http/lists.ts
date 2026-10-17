import type {
  ContainerListOptions,
  DeviceListOptions,
  IncidentListOptions,
  PageInfo,
  ServerListOptions,
  StatusCounts,
  TargetListOptions,
} from '../types'
import { record, whole } from './parse'

type ListOptions =
  | ServerListOptions
  | ContainerListOptions
  | TargetListOptions
  | DeviceListOptions
  | IncidentListOptions

/** The shared list query contract; endpoint-specific filters stay in their adapter. */
export function listQuery(options: ListOptions): Record<string, string | undefined> {
  return {
    customer: options.scope?.customerId ?? undefined,
    site: options.scope?.siteId ?? undefined,
    q: options.q?.trim() || undefined,
    status: options.status && options.status !== 'all' ? options.status : undefined,
    sort: options.sort,
    dir: options.dir,
    page: options.page === undefined ? undefined : String(options.page),
    pageSize: options.pageSize === undefined ? undefined : String(options.pageSize),
  }
}

export function parseCounts(raw: unknown): StatusCounts {
  const row = record(raw)
  return {
    healthy: whole(row.healthy),
    warning: whole(row.warning),
    critical: whole(row.critical),
    unknown: whole(row.unknown),
    idle: whole(row.idle),
  }
}

export function parsePage(raw: unknown): PageInfo {
  const row = record(raw)
  return {
    number: whole(row.number, 1),
    size: whole(row.size, 1),
    total: whole(row.total),
    pages: whole(row.pages, 1),
  }
}
