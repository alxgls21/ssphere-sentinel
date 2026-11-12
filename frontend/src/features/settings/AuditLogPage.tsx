import { useEffect } from 'react'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { AuditEntry } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { usePrefs } from '@/app/prefs'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useListQuery } from '@/hooks/useListQuery'
import { useResource } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { formatClock, formatInteger } from '@/lib/format'
import { Button, SearchField, Select, type SelectOption } from '@/ui/controls'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { CELL, HEAD, NotPermitted, SEARCH_SETTLE_MS } from './AdminParts'
import {
  auditRequest,
  changeLines,
  isDefaultAuditView,
  parseAuditQuery,
  writeAuditQuery,
} from './auditModel'

function Changes({ entry }: { entry: AuditEntry }) {
  const lines = changeLines(entry.changes)
  if (lines.length === 0) return <span className="type-data text-fg-faint">—</span>
  return (
    <ul className="type-data flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line.field} className="flex min-w-0 flex-wrap gap-x-1">
          <span className="text-fg-muted">{line.field}:</span>
          <span className="truncate" title={line.before}>
            {line.before}
          </span>
          <span aria-hidden="true" className="text-fg-faint">
            →
          </span>
          <span className="sr-only">to</span>
          <span className="truncate" title={line.after}>
            {line.after}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings > Audit log: who changed what, and when, newest first: every administrative write of
 * the console, with the fields that changed and their safe values (never a password, a token or a
 * credential). Filtered and paged by the server; read-only, and offered to administrators (or an
 * account granted the audit permission with every customer).
 */
export default function AuditLogPage() {
  const api = useApi()
  const { tz } = usePrefs()
  const { capabilities } = useAuth()
  const [query, update] = useListQuery(parseAuditQuery, writeAuditQuery)
  const may = capabilities.viewAuditLog

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = auditRequest(query, search)
  const resource = useResource(
    `audit-log:${may}:${JSON.stringify(asked)}`,
    async (signal) => (may ? api.listAuditLog({ ...asked, signal }) : null),
    { keepPreviousData: true },
  )
  const log = resource.data ?? undefined
  const rows = log?.items ?? []
  const lastPage = log && log.page.number === query.page ? log.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && log?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  const forbidden = resource.error instanceof ApiError && resource.error.status === 403
  if (!may || forbidden) {
    return (
      <NotPermitted
        what="see the audit log"
        hint="The console offers the audit trail to administrators, and to an account granted the audit permission with access to every customer. The server checks it on every request."
      />
    )
  }

  const actionOptions: SelectOption<string>[] = [
    { value: '', label: 'Any action' },
    ...(log?.actions ?? (query.action ? [{ value: query.action, label: query.action }] : [])),
  ]
  const typeOptions: SelectOption<string>[] = [
    { value: '', label: 'Any object' },
    ...(log?.targetTypes ??
      (query.targetType ? [{ value: query.targetType, label: query.targetType }] : [])),
  ]
  const matching = log?.page.total ?? 0
  const nothingThere = resource.status === 'success' && log !== undefined && log.scopeTotal === 0
  const noMatch = log !== undefined && log.scopeTotal > 0 && matching === 0
  const clear = () => update({ q: '', action: '', targetType: '' })

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Audit log</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {log ? `${formatInteger(matching)} of ${formatInteger(log.scopeTotal)} shown` : null}
        </p>
      </header>

      <search aria-label="Filter the audit log" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search the audit log"
          placeholder="Search who, what, id"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
        <Select
          label="Action"
          value={query.action}
          onChange={(action) => update({ action })}
          options={actionOptions}
        />
        <Select
          label="Object"
          value={query.targetType}
          onChange={(targetType) => update({ targetType })}
          options={typeOptions}
        />
      </search>

      <Panel
        title="Entries"
        features="settings"
        scope="NOW"
        count={log ? matching : undefined}
        status={resource.status}
        refreshing={resource.isRefreshing && log !== undefined}
        error={resource.error}
        updatedAt={resource.updatedAt}
        onRetry={resource.refetch}
        isEmpty={nothingThere || noMatch}
        empty={
          nothingThere ? (
            <EmptyState
              title="Nothing recorded yet"
              hint="Every administrative change made from the console is listed here."
            />
          ) : (
            <EmptyState
              title="No entry matches"
              hint={
                <>
                  Nothing matches the search and filters.{' '}
                  <Button size="sm" onClick={clear} className="ml-1">
                    Clear filters
                  </Button>
                </>
              }
            />
          )
        }
        skeleton={<ListSkeleton />}
        footer={
          <>
            <span className="truncate">
              Entries are never changed or deleted by the application; the retention removes the old
              ones.
            </span>
            {isDefaultAuditView(query) ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={clear}
                className={log && log.page.pages > 1 ? undefined : 'ml-auto'}
              >
                Clear filters
              </Button>
            )}
            {log && log.page.pages > 1 ? (
              <Pager
                page={log.page}
                shown={rows.length}
                onPage={(number) => update({ page: number })}
              />
            ) : null}
          </>
        }
        flush
        className="min-h-[20rem] flex-1"
      >
        <div className="min-h-0 flex-1 overflow-auto">
          <table aria-label="Audit log" className="w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <th scope="col" className={cn(HEAD, 'pl-4')}>
                  WHEN
                </th>
                <th scope="col" className={cn(HEAD, 'px-3')}>
                  WHO
                </th>
                <th scope="col" className={cn(HEAD, 'px-3')}>
                  ACTION
                </th>
                <th scope="col" className={cn(HEAD, 'px-3')}>
                  OBJECT
                </th>
                <th scope="col" className={cn(HEAD, 'hidden pr-3 @3xl:table-cell')}>
                  CHANGES
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id} className="align-top">
                  <td className={cn(CELL, 'type-data tnum py-1.5 pr-2 pl-4 text-fg-muted')}>
                    {formatClock(Date.parse(entry.at), tz)}
                  </td>
                  <td className={cn(CELL, 'type-data max-w-40 truncate px-3 py-1.5')}>
                    {entry.actor.username}
                    {entry.actor.id === null ? (
                      <span className="text-fg-faint"> (gone)</span>
                    ) : null}
                  </td>
                  <td className={cn(CELL, 'type-data-strong px-3 py-1.5')}>{entry.actionLabel}</td>
                  <td className={cn(CELL, 'type-data max-w-72 px-3 py-1.5')}>
                    <span className="text-fg-muted">{entry.targetTypeLabel}</span>{' '}
                    <span className="truncate">{entry.targetName}</span>
                    <span className="type-data block truncate text-fg-faint" title={entry.targetId}>
                      {entry.targetId}
                    </span>
                  </td>
                  <td
                    className={cn(
                      CELL,
                      'hidden max-w-96 py-1.5 pr-3 whitespace-normal @3xl:table-cell',
                    )}
                  >
                    <Changes entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}
