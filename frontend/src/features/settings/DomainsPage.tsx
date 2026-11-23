import { useContext, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { DomainRecord, DomainSortKey } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useListQuery } from '@/hooks/useListQuery'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useResource } from '@/hooks/useResource'
import { useSaveForm } from '@/hooks/useSaveForm'
import { cn } from '@/lib/cn'
import { formatInteger } from '@/lib/format'
import { FormNotice } from '@/ui/FormNotice'
import { Button, FieldInput, FieldSelect, SearchField, Select } from '@/ui/controls'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { createSortHead } from '@/ui/SortHead'
import { EmptyState } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import {
  AgeCell,
  CELL,
  FlashNotice,
  HEAD,
  NAME_LINK,
  NotPermitted,
  ROW,
  SEARCH_SETTLE_MS,
  type Flash,
} from './AdminParts'
import { useArrivalState, useRowOpen } from './adminHooks'
import { customerChoices } from './adminModel'
import {
  DOMAIN_FIELDS,
  DOMAIN_NAME_MAX,
  DOMAIN_SORT_LABEL,
  DOMAIN_STATUSES,
  EMPTY_DOMAIN,
  STATUS_DISPLAY,
  STATUS_WORD,
  domainInput,
  domainsRequest,
  nextDomainsSort,
  parseDomainsQuery,
  validateDomain,
  writeDomainsQuery,
  type DomainDraft,
  type DomainsQuery,
} from './domainsModel'
import { domainPath } from './sections'

const SortHead = createSortHead<DomainSortKey, DomainsQuery>(DOMAIN_SORT_LABEL, nextDomainsSort)

function DomainsTable({
  rows,
  query,
  onSort,
  nowMs,
}: {
  rows: readonly DomainRecord[]
  query: DomainsQuery
  onSort: (next: Pick<DomainsQuery, 'sort' | 'dir'>) => void
  nowMs: number
}) {
  const viewTo = useViewTo()
  const location = useLocation()
  const open = useRowOpen()
  const { tz } = usePrefs()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Domains" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="name" query={query} onSort={onSort} className="pl-4" />
            <SortHead sortKey="customer" query={query} onSort={onSort} />
            <SortHead sortKey="status" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @3xl:table-cell')}>
              LAST CHECKED
            </th>
            <SortHead
              sortKey="created"
              query={query}
              onSort={onSort}
              className="hidden pr-3 text-right @4xl:table-cell"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((domain) => {
            const to = viewTo(domainPath(domain.id))
            return (
              <tr key={domain.id} className={ROW} onClick={open(to)}>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'max-w-72 min-w-40 pr-2 pl-4')}>
                  <Link to={to} state={{ list: location.search }} className={NAME_LINK}>
                    <span className="min-w-0 truncate">{domain.displayName}</span>
                  </Link>
                </td>
                <td className={cn(CELL, 'type-body max-w-56 truncate px-3 text-fg-muted')}>
                  {domain.customer.name}
                </td>
                <td className={cn(CELL, 'px-3')}>
                  <StatusTag
                    status={STATUS_DISPLAY[domain.status]}
                    word={STATUS_WORD[domain.status]}
                    variant="tag"
                  />
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @3xl:table-cell')}>
                  {domain.lastCheckedAt ? (
                    <AgeCell iso={domain.lastCheckedAt} nowMs={nowMs} tz={tz} what="Checked" />
                  ) : (
                    <span className="text-fg-faint">never</span>
                  )}
                </td>
                <td className={cn(CELL, 'type-data tnum hidden pr-3 text-right @4xl:table-cell')}>
                  <AgeCell iso={domain.createdAt} nowMs={nowMs} tz={tz} what="Added" />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DomainsCards({ rows }: { rows: readonly DomainRecord[] }) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Domains" className="min-h-0 flex-1 overflow-auto">
      {rows.map((domain) => (
        <li key={domain.id} className="border-b border-border last:border-b-0">
          <Link
            to={viewTo(domainPath(domain.id))}
            state={{ list: location.search }}
            className="flex flex-col gap-1 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
          >
            <span className="flex items-center gap-2">
              <span className="type-data-strong min-w-0 flex-1 truncate">{domain.displayName}</span>
              <StatusTag
                status={STATUS_DISPLAY[domain.status]}
                word={STATUS_WORD[domain.status]}
                variant="tag"
              />
            </span>
            <span className="type-body truncate text-fg-muted">{domain.customer.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Adds a domain to a customer, then opens it: that page shows the record to put in the DNS. */
function AddDomain() {
  const api = useApi()
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const shell = useContext(ShellContext)
  const scope = useResource('domain-customers', (signal) => api.getScopeOptions({ signal }), {})
  const [draft, setDraft] = useState<DomainDraft>(EMPTY_DOMAIN)
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(DOMAIN_FIELDS, shell?.announce, summary)
  const exists =
    form.failure?.code === 'domain_exists' || form.failure?.code === 'domain_limit'
      ? form.failure.message
      : null
  const errors = { ...form.errors, ...(exists ? { name: [exists] } : {}) }
  const lines = exists ? [] : form.lines

  const edit = (changes: Partial<DomainDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    form.touched()
  }
  const submit = () =>
    form.submit(
      validateDomain(draft),
      async () => {
        const created = await api.createDomain(domainInput(draft))
        shell?.announce('Domain added.')
        void navigate(viewTo(domainPath(created.item.id)), { state: { created: true } })
      },
      { failed: 'The domain was not added.' },
    )

  return (
    <form
      aria-label="Add a domain"
      className="flex flex-col gap-3 rounded-sm border border-border bg-panel p-4"
      noValidate
      aria-busy={form.saving}
      onSubmit={(event) => {
        event.preventDefault()
        if (!form.saving) void submit()
      }}
    >
      <h2 className="type-label text-fg-muted">Add a domain</h2>
      <FormNotice
        ref={summary}
        invalid={Object.keys(errors).filter(
          (name) => (errors[name as keyof typeof errors]?.length ?? 0) > 0,
        )}
        lines={lines}
      />
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-start">
        <FieldSelect
          label="Customer"
          value={draft.customerId}
          onChange={(customerId) => edit({ customerId })}
          options={customerChoices(scope.data ?? { customers: [], sites: [] })}
          error={errors.customerId}
          disabled={form.saving}
        />
        <FieldInput
          label="Domain"
          value={draft.name}
          onChange={(name) => edit({ name })}
          error={errors.name}
          input={{
            disabled: form.saving,
            autoComplete: 'off',
            autoCapitalize: 'none',
            spellCheck: false,
            required: true,
            maxLength: DOMAIN_NAME_MAX,
          }}
          hint="The name as you know it, for example example.com. Unicode names are fine."
        />
        <Button type="submit" variant="primary" disabled={form.saving} className="md:mt-6">
          {form.saving ? 'Adding…' : 'Add domain'}
        </Button>
      </div>
    </form>
  )
}

/**
 * Settings > Domains: the domains customers ask Sentinel to monitor, searched, filtered by state,
 * sorted and paged by the server. A domain is monitored only once its customer has put the record
 * in the domain's DNS and a verification has found it; each domain opens on its own page for that.
 */
export default function DomainsPage() {
  const api = useApi()
  const { capabilities } = useAuth()
  const [query, update] = useListQuery(parseDomainsQuery, writeDomainsQuery)
  const wide = useMediaQuery('(min-width: 48rem)')
  const may = capabilities.viewDomains
  const arrival = useArrivalState<{ deleted?: string; customer?: string }>()
  const [flash, setFlash] = useState<Flash | null>(() =>
    arrival.deleted
      ? {
          tone: 'ok',
          text: `The domain ${arrival.deleted}${arrival.customer ? ` of ${arrival.customer}` : ''} is deleted, with its verification history.`,
        }
      : null,
  )

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = domainsRequest(query, search)
  const resource = useResource(
    `domains:${may}:${JSON.stringify(asked)}`,
    async (signal) => (may ? api.listDomains({ ...asked, signal }) : null),
    { keepPreviousData: true },
  )
  const list = resource.data ?? undefined
  const rows = list?.items ?? []
  const nowMs = list ? Date.parse(list.generatedAt) : 0
  const lastPage = list && list.page.number === query.page ? list.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && list?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  const forbidden = resource.error instanceof ApiError && resource.error.status === 403
  if (!may || forbidden) {
    return (
      <NotPermitted
        what="see monitored domains"
        hint="The console offers this only to an account that holds the permissions on monitored domains and sees every customer. The server checks it on every request."
      />
    )
  }

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Domains</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
      </header>

      <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />

      {capabilities.addDomains ? <AddDomain /> : null}

      <search aria-label="Filter domains" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search domains"
          placeholder="Search domain, customer"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
        <Select
          label="State"
          value={query.status}
          onChange={(status) => update({ status })}
          options={[
            { value: 'all', label: 'All states' },
            ...DOMAIN_STATUSES.map((status) => ({
              value: status,
              label: `${STATUS_WORD[status]}${list ? ` (${list.counts[status]})` : ''}`,
            })),
          ]}
        />
      </search>

      <Panel
        title="Domains"
        features="settings"
        scope="NOW"
        count={list ? matching : undefined}
        status={resource.status}
        refreshing={resource.isRefreshing && list !== undefined}
        error={resource.error}
        updatedAt={resource.updatedAt}
        onRetry={resource.refetch}
        isEmpty={nothingThere || noMatch}
        empty={
          nothingThere ? (
            <EmptyState
              title="No domains"
              hint="A domain is monitored once it is added and its record is found in its DNS."
            />
          ) : (
            <EmptyState
              title="No domain matches"
              hint={
                <>
                  Nothing matches the search or the state.{' '}
                  <Button
                    size="sm"
                    onClick={() => update({ q: '', status: 'all' })}
                    className="ml-1"
                  >
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
              A domain is added and verified here, and never changed. An administrator may delete
              one.
            </span>
            {list && list.page.pages > 1 ? (
              <Pager
                page={list.page}
                shown={rows.length}
                onPage={(number) => update({ page: number })}
              />
            ) : null}
          </>
        }
        flush
        className="min-h-[20rem] flex-1"
      >
        {wide ? (
          <DomainsTable rows={rows} query={query} onSort={update} nowMs={nowMs} />
        ) : (
          <DomainsCards rows={rows} />
        )}
      </Panel>
    </div>
  )
}
