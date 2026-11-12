import type { Deleted, RecordList } from '../types'
import { parsePage } from './lists'
import { array, record, text, time, whole } from './parse'

/**
 * What the administration lists share: the envelope of a page of records (no health counts), the
 * answer of a deletion, and the query of a list, with only what differs from the defaults sent.
 */

export function parseRecordList<Item>(
  raw: unknown,
  parseItem: (item: unknown) => Item,
): RecordList<Item> {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseItem),
    page: parsePage(row.page),
    scopeTotal: whole(row.scopeTotal),
  }
}

export function parseDeleted(raw: unknown): Deleted {
  const row = record(raw)
  const deleted = record(row.deleted)
  return {
    generatedAt: time(row.generatedAt),
    deleted: { id: text(deleted.id), name: text(deleted.name) },
  }
}

/** A query value: a trimmed search, a choice that is not `all`, a number as text; `undefined` is not sent. */
export const notAll = (value: string | undefined): string | undefined =>
  value && value !== 'all' ? value : undefined
export const pageText = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : String(value)
export const searchText = (value: string | undefined): string | undefined =>
  value?.trim() || undefined

/** The body of a write, field by field: a field left out stays out, so nothing the caller holds goes out unasked. */
export function body(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) out[name] = value
  return out
}
