import { useContext, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type {
  AlertRule,
  ChangeEffects,
  IncidentKindFilter,
  IncidentSeverityFilter,
  RuleEnabledFilter,
  RuleScopeFilter,
  RuleSortKey,
} from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { usePrefs } from '@/app/prefs'
import { ShellContext } from '@/app/shell'
import { useViewTo } from '@/app/viewSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useResource } from '@/hooks/useResource'
import { describeWriteFailure } from '@/lib/forms'
import { formatInteger } from '@/lib/format'
import { effectsSentence, previewChange, valuesOf, type ChangePreview } from '@/lib/ruleChanges'
import { Button, Chip, SearchField, Select, type SelectOption } from '@/ui/controls'
import { buttonStyle } from '@/ui/controls/buttonStyle'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { EmptyState, Notice } from '@/ui/states'
import { ChangeConfirm } from './ChangeConfirm'
import { RulesCards } from './RulesCards'
import { RulesTable } from './RulesTable'
import {
  ENABLED_FILTERS,
  ENABLED_LABEL,
  FIRST_DIR,
  KIND_FILTERS,
  KIND_LABEL,
  SCOPE_FILTERS,
  SCOPE_LABEL,
  SEVERITY_FILTERS,
  SEVERITY_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  isDefaultView,
  requestOf,
} from './rulesModel'
import { NEW_RULE_PATH } from './sections'
import { useRulesQuery } from './useRulesQuery'

const SORT_OPTIONS: readonly SelectOption<RuleSortKey>[] = SORT_KEYS.map((key) => ({
  value: key,
  label: SORT_LABEL[key],
}))
const KIND_OPTIONS: readonly SelectOption<IncidentKindFilter>[] = KIND_FILTERS.map((kind) => ({
  value: kind,
  label: KIND_LABEL[kind],
}))
const SCOPE_OPTIONS: readonly SelectOption<RuleScopeFilter>[] = SCOPE_FILTERS.map((scope) => ({
  value: scope,
  label: SCOPE_LABEL[scope],
}))

/** How long the search must hold still before it is asked for. */
const SEARCH_SETTLE_MS = 250

/**
 * What switching a rule off ends, as the API has always stated it. Used only until the options (which
 * carry the whole contract) have arrived: a rule with open incidents is never disabled unwarned.
 */
const DISABLING_ENDS: ChangeEffects = {
  enabled: { to: false, closes: 'rule_disabled', which: 'all' },
}

type Flash = { tone: 'ok' | 'error' | 'conflict'; text: string }

/**
 * Settings > Alert rules: every rule, searched, filtered, sorted and paged by the server, whose
 * counts are the chips and the header. An account that may change rules can switch one on or off from
 * here; switching one off that has open incidents asks first, from the API's own contract. A rule
 * changed elsewhere meanwhile is never overwritten: the list says so and reads it again.
 */
export default function AlertRulesPage() {
  const api = useApi()
  const { tz } = usePrefs()
  const shell = useContext(ShellContext)
  const viewTo = useViewTo()
  const { capabilities } = useAuth()
  const [query, update] = useRulesQuery()
  const wide = useMediaQuery('(min-width: 48rem)')
  const mayView = capabilities.viewAlertRules
  const mayEdit = capabilities.editAlertRules

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = requestOf(query, search)
  const resource = useResource(
    `alert-rules:${mayView}:${JSON.stringify(asked)}`,
    async (signal) => (mayView ? api.listAlertRules({ ...asked, signal }) : null),
    { keepPreviousData: true },
  )
  // The contract of what ends incidents, read only when this account may change rules.
  const options = useResource(`alert-rules-options:${mayEdit}`, async (signal) =>
    mayEdit ? api.getAlertRuleOptions({ signal }) : null,
  )
  const effects = options.data?.changeEffects ?? DISABLING_ENDS

  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [confirm, setConfirm] = useState<{ rule: AlertRule; preview: ChangePreview } | null>(null)

  const list = resource.data ?? undefined
  const rows = list?.items ?? []
  const nowMs = list ? Date.parse(list.generatedAt) : 0

  const lastPage = list && list.page.number === query.page ? list.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && list?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  const send = async (rule: AlertRule, enabled: boolean) => {
    setConfirm(null)
    setBusy(rule.id)
    setFlash(null)
    try {
      const change = await api.updateAlertRule(rule.id, { enabled, version: rule.version })
      const text = `“${rule.name}” is ${enabled ? 'enabled' : 'disabled'}. ${effectsSentence(change.effects)}`
      setFlash({ tone: 'ok', text })
      shell?.announce(text)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        const text = `“${rule.name}” was changed elsewhere since this list was read, so nothing was changed. The list is read again: look at it, then decide.`
        setFlash({ tone: 'conflict', text })
        shell?.announce(text)
      } else {
        const failure = describeWriteFailure(error, [])
        const text = [...failure.general, failure.message].filter(Boolean).join(' ')
        setFlash({ tone: 'error', text: text || 'The change could not be saved.' })
        shell?.announce('The alert rule was not changed.')
      }
    } finally {
      setBusy(null)
      resource.refetch()
    }
  }

  const toggle = (rule: AlertRule) => {
    const enabled = !rule.enabled
    const preview = previewChange(rule, { ...valuesOf(rule), enabled }, effects)
    if (preview.warns) setConfirm({ rule, preview })
    else void send(rule, enabled)
  }

  // Whatever the session said, the server has the last word: a refused read is a refusal.
  const forbidden = resource.error instanceof ApiError && resource.error.status === 403
  if (!mayView || forbidden) {
    const createOnly = !mayView && capabilities.createAlertRules
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState
            title={createOnly ? 'The rules cannot be listed' : 'Not permitted to see alert rules'}
            hint={
              createOnly
                ? 'This account may create a rule but not see the existing ones.'
                : 'The console offers alert rules only to an account with the permission and the access to every customer. The server checks it on every request.'
            }
          />
        </div>
        {createOnly ? (
          <Link to={viewTo(NEW_RULE_PATH)} className={`${buttonStyle('primary')} w-fit`}>
            New rule
          </Link>
        ) : null}
      </div>
    )
  }

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0
  const clear = () => update({ q: '', enabled: 'all', kind: 'all', severity: 'all', scope: 'all' })

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Alert rules</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
        {capabilities.createAlertRules ? (
          <Link to={viewTo(NEW_RULE_PATH)} className={`${buttonStyle('primary')} ml-auto`}>
            New rule
          </Link>
        ) : null}
      </header>

      {confirm ? (
        <ChangeConfirm
          preview={confirm.preview}
          rule={confirm.rule.name}
          confirmLabel="Disable and end incidents"
          busy={busy !== null}
          onConfirm={() => void send(confirm.rule, !confirm.rule.enabled)}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {flash ? (
        <Notice
          status={
            flash.tone === 'ok' ? 'healthy' : flash.tone === 'conflict' ? 'warning' : 'critical'
          }
          word={
            flash.tone === 'ok'
              ? 'SAVED'
              : flash.tone === 'conflict'
                ? 'CHANGED ELSEWHERE'
                : 'NOT SAVED'
          }
          live={flash.tone === 'ok' ? 'status' : 'alert'}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setFlash(null)}>
              Dismiss
            </Button>
          }
        >
          {flash.text}
        </Notice>
      ) : null}

      <search aria-label="Filter alert rules" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search alert rules"
            placeholder="Search name, description, customer, site"
            value={query.q}
            onChange={(q) => update({ q })}
            className="w-full sm:w-80"
          />
          <Select
            label="Kind"
            value={query.kind}
            onChange={(kind) => update({ kind })}
            options={KIND_OPTIONS}
          />
          <Select
            label="Scope"
            value={query.scope}
            onChange={(scope) => update({ scope })}
            options={SCOPE_OPTIONS}
          />
          <fieldset className="flex min-w-0 flex-wrap gap-1">
            <legend className="sr-only">Filter by severity</legend>
            {SEVERITY_FILTERS.map((filter: IncidentSeverityFilter) => (
              <Chip
                key={filter}
                pressed={query.severity === filter}
                onPressedChange={(pressed) => update({ severity: pressed ? filter : 'all' })}
              >
                {SEVERITY_LABEL[filter]}
              </Chip>
            ))}
          </fieldset>
          {wide ? null : (
            <Select
              label="Sort by"
              value={query.sort}
              onChange={(sort) => update({ sort, dir: FIRST_DIR[sort] })}
              options={SORT_OPTIONS}
              className="ml-auto"
            />
          )}
        </div>
        <fieldset className="flex min-w-0 flex-wrap gap-1">
          <legend className="sr-only">Filter by state</legend>
          {ENABLED_FILTERS.map((filter: RuleEnabledFilter) => (
            <Chip
              key={filter}
              pressed={query.enabled === filter}
              onPressedChange={(pressed) => update({ enabled: pressed ? filter : 'all' })}
              count={
                list
                  ? filter === 'all'
                    ? list.counts.enabled + list.counts.disabled
                    : list.counts[filter]
                  : undefined
              }
            >
              {ENABLED_LABEL[filter]}
            </Chip>
          ))}
        </fieldset>
      </search>

      <Panel
        title="Rules"
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
              title="No alert rules"
              hint="None has been created, so no incident can open. A rule says what to watch and when to open an incident."
            />
          ) : (
            <EmptyState
              title="No rule matches"
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
              Rules are disabled, never deleted: an incident keeps its rule.
            </span>
            {isDefaultView(query) ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={clear}
                className={list && list.page.pages > 1 ? undefined : 'ml-auto'}
              >
                Clear filters
              </Button>
            )}
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
          <RulesTable
            rows={rows}
            query={query}
            onSort={update}
            nowMs={nowMs}
            tz={tz}
            mayEdit={mayEdit}
            busy={busy}
            onToggle={toggle}
          />
        ) : (
          <RulesCards rows={rows} mayEdit={mayEdit} busy={busy} onToggle={toggle} />
        )}
      </Panel>
    </div>
  )
}
