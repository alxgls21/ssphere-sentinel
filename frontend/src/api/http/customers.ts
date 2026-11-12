import type { SentinelApi } from '../client'
import type {
  CustomerDetail,
  CustomerInput,
  CustomerPatch,
  CustomerRecord,
  RecordListOptions,
  SiteDetail,
  SiteInput,
  SiteListOptions,
  SitePatch,
  SiteRecord,
} from '../types'
import { array, record, text, time, whole } from './parse'
import { body, pageText, parseDeleted, parseRecordList, searchText } from './records'
import type { Transport } from './transport'

/**
 * The console API's customers and sites: the lists (`customers/`, `sites/`), one of each with what
 * belongs to it (`customers/<id>/` with its sites, `sites/<id>/`), and the writes (POST, PATCH,
 * DELETE on the same URLs). Every answer is validated and mapped by naming each field; what a
 * write carries is named field by field too.
 */

export function parseCustomer(raw: unknown): CustomerRecord {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    notes: text(row.notes),
    sites: whole(row.sites),
    servers: whole(row.servers),
    devices: whole(row.devices),
    targets: whole(row.targets),
    domains: whole(row.domains),
    createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt),
  }
}

export function parseSite(raw: unknown): SiteRecord {
  const row = record(raw)
  return {
    id: text(row.id),
    customerId: text(row.customerId),
    customerName: text(row.customerName),
    name: text(row.name),
    description: text(row.description),
    servers: whole(row.servers),
    devices: whole(row.devices),
    targets: whole(row.targets),
    createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt),
  }
}

export function parseCustomerDetail(raw: unknown): CustomerDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseCustomer(row.item),
    sites: array(row.sites).map(parseSite),
  }
}

export function parseSiteDetail(raw: unknown): SiteDetail {
  const row = record(raw)
  return { generatedAt: time(row.generatedAt), item: parseSite(row.item) }
}

function listQuery(options: RecordListOptions): Record<string, string | undefined> {
  return {
    q: searchText(options.q),
    sort: options.sort,
    dir: options.dir,
    page: pageText(options.page),
    pageSize: pageText(options.pageSize),
  }
}

/** An id is a path segment: it is encoded, never trusted. */
const customerPath = (id: string) => `customers/${encodeURIComponent(id)}/`
const sitePath = (id: string) => `sites/${encodeURIComponent(id)}/`

const customerBody = (input: CustomerPatch) => body({ name: input.name, notes: input.notes })
const siteBody = (input: SitePatch) =>
  body({ customerId: input.customerId, name: input.name, description: input.description })

export const listCustomers =
  (transport: Transport): SentinelApi['listCustomers'] =>
  async (options = {}) =>
    parseRecordList(
      await transport.get('customers/', { signal: options.signal, query: listQuery(options) }),
      parseCustomer,
    )

export const getCustomer =
  (transport: Transport): SentinelApi['getCustomer'] =>
  async (id, options) =>
    parseCustomerDetail(await transport.get(customerPath(id), { signal: options?.signal }))

export const createCustomer =
  (transport: Transport): SentinelApi['createCustomer'] =>
  async (input: CustomerInput, options) =>
    parseCustomerDetail(
      await transport.post('customers/', customerBody(input), { signal: options?.signal }),
    )

export const updateCustomer =
  (transport: Transport): SentinelApi['updateCustomer'] =>
  async (id, patch, options) =>
    parseCustomerDetail(
      await transport.patch(customerPath(id), customerBody(patch), { signal: options?.signal }),
    )

export const deleteCustomer =
  (transport: Transport): SentinelApi['deleteCustomer'] =>
  async (id, options) =>
    parseDeleted(await transport.delete(customerPath(id), { signal: options?.signal }))

export const listSites =
  (transport: Transport): SentinelApi['listSites'] =>
  async (options: SiteListOptions = {}) =>
    parseRecordList(
      await transport.get('sites/', {
        signal: options.signal,
        query: { ...listQuery(options), customer: options.customer },
      }),
      parseSite,
    )

export const getSite =
  (transport: Transport): SentinelApi['getSite'] =>
  async (id, options) =>
    parseSiteDetail(await transport.get(sitePath(id), { signal: options?.signal }))

export const createSite =
  (transport: Transport): SentinelApi['createSite'] =>
  async (input: SiteInput, options) =>
    parseSiteDetail(await transport.post('sites/', siteBody(input), { signal: options?.signal }))

export const updateSite =
  (transport: Transport): SentinelApi['updateSite'] =>
  async (id, patch, options) =>
    parseSiteDetail(
      await transport.patch(sitePath(id), siteBody(patch), { signal: options?.signal }),
    )

export const deleteSite =
  (transport: Transport): SentinelApi['deleteSite'] =>
  async (id, options) =>
    parseDeleted(await transport.delete(sitePath(id), { signal: options?.signal }))
