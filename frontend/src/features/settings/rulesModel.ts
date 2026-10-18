import type {
  AlertRule,
  AlertRuleListOptions,
  AlertRuleScope,
  IncidentKindFilter,
  IncidentSeverityFilter,
  RuleEnabledFilter,
  RuleScopeFilter,
  RuleSortKey,
  SortDirection,
} from '@/api/types'
import { formatDuration } from '@/lib/format'
import { HEALTH_CONDITION_TEXT, reasonText } from '@/lib/incidents'

/**
 * What the alert rules list asks for and the words it uses. Pure, so it is tested without a screen.
 * Which rules, in what order and on which page is the console API's answer; so are the counts.
 */

export interface RulesQuery {
  q: string
  enabled: RuleEnabledFilter
  kind: IncidentKindFilter
  severity: IncidentSeverityFilter
  scope: RuleScopeFilter
  sort: RuleSortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

export const DEFAULT_QUERY: RulesQuery = {
  q: '',
  enabled: 'all',
  kind: 'all',
  severity: 'all',
  scope: 'all',
  sort: 'name',
  dir: 'asc',
  page: 1,
}

export const MAX_PAGE = 10_000
export const RULES_PAGE_SIZE = 50

export const ENABLED_FILTERS: readonly RuleEnabledFilter[] = ['all', 'enabled', 'disabled']
export const ENABLED_LABEL: Record<RuleEnabledFilter, string> = {
  all: 'ALL',
  enabled: 'ENABLED',
  disabled: 'DISABLED',
}

export const SEVERITY_FILTERS: readonly IncidentSeverityFilter[] = ['all', 'critical', 'warning']
export const SEVERITY_LABEL: Record<IncidentSeverityFilter, string> = {
  all: 'ALL',
  critical: 'CRIT',
  warning: 'WARN',
}

export const KIND_FILTERS: readonly IncidentKindFilter[] = [
  'all',
  'server',
  'container',
  'target',
  'device',
  'interface',
]
export const KIND_LABEL: Record<IncidentKindFilter, string> = {
  all: 'All kinds',
  server: 'Servers',
  container: 'Containers',
  target: 'Network targets',
  device: 'SNMP devices',
  interface: 'Interfaces',
}

export const SCOPE_FILTERS: readonly RuleScopeFilter[] = ['all', 'global', 'customer', 'site']
export const SCOPE_LABEL: Record<RuleScopeFilter, string> = {
  all: 'Any scope',
  global: 'All customers and sites',
  customer: 'One customer',
  site: 'One site',
}

export const SORT_KEYS: readonly RuleSortKey[] = ['name', 'kind', 'severity', 'updated']
export const SORT_LABEL: Record<RuleSortKey, string> = {
  name: 'Name',
  kind: 'Kind',
  severity: 'Severity',
  updated: 'Updated',
}

/** What a column sorts by first: names and kinds A to Z, the most severe, the most recently changed. */
export const FIRST_DIR: Record<RuleSortKey, SortDirection> = {
  name: 'asc',
  kind: 'asc',
  severity: 'asc',
  updated: 'desc',
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value)

function wholePage(value: string | null): number {
  const page = value !== null && /^\d{1,5}$/.test(value) ? Number(value) : 1
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

export function parseQuery(params: URLSearchParams): RulesQuery {
  const sort = params.get('sort')
  const dir = params.get('dir')
  const key = isOneOf(SORT_KEYS, sort) ? sort : DEFAULT_QUERY.sort
  const enabled = params.get('enabled')
  const kind = params.get('kind')
  const severity = params.get('severity')
  const scope = params.get('scope')
  return {
    q: params.get('q') ?? '',
    enabled: isOneOf(ENABLED_FILTERS, enabled) ? enabled : DEFAULT_QUERY.enabled,
    kind: isOneOf(KIND_FILTERS, kind) ? kind : DEFAULT_QUERY.kind,
    severity: isOneOf(SEVERITY_FILTERS, severity) ? severity : DEFAULT_QUERY.severity,
    scope: isOneOf(SCOPE_FILTERS, scope) ? scope : DEFAULT_QUERY.scope,
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

/** Writes a query into URL params, omitting defaults to keep links short. Other params are kept. */
export function writeQuery(params: URLSearchParams, query: RulesQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  const set = (name: string, value: string, isDefault: boolean) => {
    if (isDefault) next.delete(name)
    else next.set(name, value)
  }
  set('q', query.q.trim(), query.q.trim() === '')
  set('enabled', query.enabled, query.enabled === DEFAULT_QUERY.enabled)
  set('kind', query.kind, query.kind === DEFAULT_QUERY.kind)
  set('severity', query.severity, query.severity === DEFAULT_QUERY.severity)
  set('scope', query.scope, query.scope === DEFAULT_QUERY.scope)
  set('sort', query.sort, query.sort === DEFAULT_QUERY.sort)
  set('dir', query.dir, query.dir === FIRST_DIR[query.sort])
  set('page', String(query.page), query.page === DEFAULT_QUERY.page)
  return next
}

export function nextSort(query: RulesQuery, key: RuleSortKey): Pick<RulesQuery, 'sort' | 'dir'> {
  if (query.sort === key) return { sort: key, dir: query.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: FIRST_DIR[key] }
}

export const isDefaultView = (query: RulesQuery): boolean =>
  query.q.trim() === '' &&
  query.enabled === 'all' &&
  query.kind === 'all' &&
  query.severity === 'all' &&
  query.scope === 'all'

export const requestOf = (query: RulesQuery, q: string): AlertRuleListOptions => ({
  q,
  enabled: query.enabled,
  kind: query.kind,
  severity: query.severity,
  scope: query.scope,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: RULES_PAGE_SIZE,
})

/** The scope of a rule in words: who it concerns. */
export function scopeText(scope: AlertRuleScope): string {
  switch (scope.type) {
    case 'all':
      return 'All customers and sites'
    case 'customer':
      return scope.customerName ?? 'One customer'
    case 'site':
      return [scope.customerName, scope.siteName].filter(Boolean).join(' / ') || 'One site'
  }
}

/** What the scope is, in a word for a column. */
export const SCOPE_WORD: Record<AlertRuleScope['type'], string> = {
  all: 'ALL',
  customer: 'CUSTOMER',
  site: 'SITE',
}

/** "Critical · offline: no heartbeat": what the rule fires on, and for which reason. */
export const conditionOf = (rule: AlertRule): string => {
  const why = reasonText(rule.kind, rule.reason)
  return `${HEALTH_CONDITION_TEXT[rule.health]}${why ? ` · ${why}` : ''}`
}

/** "1m 0s → 2m 0s": how long it must hold to open, and stay clear to recover. */
export const timingOf = (rule: AlertRule): string =>
  `${formatDuration(rule.activationSeconds)} → ${formatDuration(rule.recoverySeconds)}`

export const TIMING_TITLE =
  'Activation delay → recovery delay: how long the condition must hold before an incident opens, and stay clear before it recovers.'
