import type { ContainerList, ContainerListItem, ContainerListOptions } from '../types'
import { array, record, text, time, whole } from './parse'
import { parseContainer, parseCounts, parsePage } from './servers'
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

/** The query string of a list request: what is left at its default is not sent. */
function listQuery(options: ContainerListOptions): Record<string, string | undefined> {
  return {
    customer: options.scope?.customerId ?? undefined,
    site: options.scope?.siteId ?? undefined,
    status: options.status && options.status !== 'all' ? options.status : undefined,
    sort: options.sort,
    dir: options.dir,
    page: options.page === undefined ? undefined : String(options.page),
    pageSize: options.pageSize === undefined ? undefined : String(options.pageSize),
  }
}

export const listContainers =
  (transport: Transport) =>
  async (options: ContainerListOptions = {}): Promise<ContainerList> =>
    parseContainerList(
      await transport.get('containers/', { signal: options.signal, query: listQuery(options) }),
    )
