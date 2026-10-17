import type { SentinelApi } from '../client'
import type { ContainerList, ContainerListItem, ContainerListOptions } from '../types'
import { listQuery, parseCounts, parsePage } from './lists'
import { array, record, text, time, whole } from './parse'
import { parseContainer } from './servers'
import type { Transport } from './transport'

/**
 * The console API's container list (`containers/`): every container of every visible server,
 * with the server it runs on. Every answer is validated and mapped onto the view-models of
 * api/types; one that does not fit is a `bad_response` error, never a guess.
 */

function parseItem(raw: unknown): ContainerListItem {
  const row = record(raw)
  return {
    ...parseContainer(raw),
    serverName: text(row.serverName),
    ...(row.customerName === undefined ? {} : { customerName: text(row.customerName) }),
    ...(row.siteName === undefined ? {} : { siteName: text(row.siteName) }),
  }
}

export function parseContainerList(raw: unknown): ContainerList {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseItem),
    page: parsePage(row.page),
    counts: parseCounts(row.counts),
    scopeTotal: whole(row.scopeTotal),
  }
}

export const listContainers =
  (transport: Transport): SentinelApi['listContainers'] =>
  async (options: ContainerListOptions = {}): Promise<ContainerList> =>
    parseContainerList(
      await transport.get('containers/', {
        signal: options.signal,
        query: { ...listQuery(options), server: options.server || undefined },
      }),
    )
