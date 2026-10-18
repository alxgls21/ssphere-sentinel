import type { SentinelApi } from '../client'
import type {
  AlertRule,
  AlertRuleChange,
  AlertRuleDetail,
  AlertRuleInput,
  AlertRuleList,
  AlertRuleListOptions,
  AlertRuleOptions,
  AlertRulePatch,
  AlertRuleScope,
  AlertSeverity,
  ChangeEffects,
  IncidentConditionHealth,
  IncidentEntityKind,
  RuleClosure,
  RuleEffects,
  RuleScopeType,
} from '../types'
import { parsePage } from './lists'
import { array, flag, nullableText, oneOf, record, text, time, whole } from './parse'
import type { Transport } from './transport'

/**
 * The console API's alert rules: the list (`alert-rules/`), one rule (`alert-rules/<id>/`), a
 * new one (POST), a change (PATCH, with the version that was read) and what a form may offer
 * (`alert-rules/options/`). Every answer is validated and mapped by naming each field. What a
 * request carries is named field by field too: a rule's key, its kind on a change and every
 * other field the console does not mean to set can never go out.
 */

const KIND: readonly IncidentEntityKind[] = ['server', 'container', 'target', 'device', 'interface']
const CONDITION: readonly IncidentConditionHealth[] = ['critical', 'warning', 'unknown']
const SEVERITY: readonly AlertSeverity[] = ['critical', 'warning']
const SCOPE: readonly RuleScopeType[] = ['all', 'customer', 'site']
const CLOSURE: readonly RuleClosure[] = ['rule_disabled', 'rule_changed', 'out_of_scope']

function parseScope(raw: unknown): AlertRuleScope {
  const row = record(raw)
  return {
    type: oneOf(SCOPE, row.type),
    customerId: nullableText(row.customerId),
    customerName: nullableText(row.customerName),
    siteId: nullableText(row.siteId),
    siteName: nullableText(row.siteName),
  }
}

export function parseAlertRule(raw: unknown): AlertRule {
  const row = record(raw)
  return {
    id: text(row.id),
    key: nullableText(row.key),
    name: text(row.name),
    description: text(row.description),
    enabled: flag(row.enabled),
    kind: oneOf(KIND, row.kind),
    health: oneOf(CONDITION, row.health),
    reason: nullableText(row.reason),
    severity: oneOf(SEVERITY, row.severity),
    activationSeconds: whole(row.activationSeconds),
    recoverySeconds: whole(row.recoverySeconds),
    scope: parseScope(row.scope),
    openIncidents: whole(row.openIncidents),
    createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt),
    version: whole(row.version),
    canEdit: flag(row.canEdit),
  }
}

export function parseChangeEffects(raw: unknown): ChangeEffects {
  const effects: ChangeEffects = {}
  for (const [field, value] of Object.entries(record(raw))) {
    const row = record(value)
    effects[field] = {
      closes: oneOf(CLOSURE, row.closes),
      which: text(row.which),
      ...(row.to === undefined ? {} : { to: flag(row.to) }),
    }
  }
  return effects
}

export function parseAlertRuleList(raw: unknown): AlertRuleList {
  const row = record(raw)
  const counts = record(row.counts)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseAlertRule),
    page: parsePage(row.page),
    counts: { enabled: whole(counts.enabled), disabled: whole(counts.disabled) },
    scopeTotal: whole(row.scopeTotal),
  }
}

export function parseAlertRuleDetail(raw: unknown): AlertRuleDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseAlertRule(row.item),
    changeEffects: parseChangeEffects(row.changeEffects),
  }
}

function parseEffects(raw: unknown): RuleEffects | null {
  if (raw === null) return null
  const row = record(raw)
  return {
    openIncidents: whole(row.openIncidents),
    closes: array(row.closes).map((closure) => oneOf(CLOSURE, closure)),
    closesAll: flag(row.closesAll),
  }
}

export function parseAlertRuleChange(raw: unknown): AlertRuleChange {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseAlertRule(row.item),
    effects: parseEffects(row.effects),
  }
}

export function parseAlertRuleOptions(raw: unknown): AlertRuleOptions {
  const row = record(raw)
  const defaults = record(row.defaults)
  const limits = record(row.limits)
  return {
    generatedAt: time(row.generatedAt),
    kinds: array(row.kinds).map((value) => {
      const kind = record(value)
      return {
        value: oneOf(KIND, kind.value),
        label: text(kind.label),
        conditions: array(kind.conditions).map((entry) => {
          const condition = record(entry)
          return {
            health: oneOf(CONDITION, condition.health),
            label: text(condition.label),
            reasons: array(condition.reasons).map(text),
          }
        }),
      }
    }),
    severities: array(row.severities).map((value) => {
      const severity = record(value)
      return { value: oneOf(SEVERITY, severity.value), label: text(severity.label) }
    }),
    defaults: {
      enabled: flag(defaults.enabled),
      activationSeconds: whole(defaults.activationSeconds),
      recoverySeconds: whole(defaults.recoverySeconds),
    },
    limits: {
      maxDurationSeconds: whole(limits.maxDurationSeconds, 1),
      nameMaxLength: whole(limits.nameMaxLength, 1),
      descriptionMaxLength: whole(limits.descriptionMaxLength, 1),
    },
    changeEffects: parseChangeEffects(row.changeEffects),
  }
}

/** The list query: only what differs from the defaults is sent. */
function listQuery(options: AlertRuleListOptions): Record<string, string | undefined> {
  const not = (value: string | undefined) => (value && value !== 'all' ? value : undefined)
  return {
    q: options.q?.trim() || undefined,
    enabled: not(options.enabled),
    kind: not(options.kind),
    severity: not(options.severity),
    scope: not(options.scope),
    sort: options.sort,
    dir: options.dir,
    page: options.page === undefined ? undefined : String(options.page),
    pageSize: options.pageSize === undefined ? undefined : String(options.pageSize),
  }
}

/**
 * The body of a write, field by field. A field left out stays as it is (a change) or takes the
 * server's default (a new rule); `null` is sent only for what means "none" (any reason, no customer).
 */
function body(input: Partial<AlertRuleInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const set = (name: string, value: unknown) => {
    if (value !== undefined) out[name] = value
  }
  set('name', input.name)
  set('description', input.description)
  set('enabled', input.enabled)
  set('kind', input.kind)
  set('health', input.health)
  set('reason', input.reason)
  set('severity', input.severity)
  set('activationSeconds', input.activationSeconds)
  set('recoverySeconds', input.recoverySeconds)
  set('customerId', input.customerId)
  set('siteId', input.siteId)
  return out
}

/** A rule id is a path segment: it is encoded, never trusted. */
const rulePath = (id: string) => `alert-rules/${encodeURIComponent(id)}/`

export const listAlertRules =
  (transport: Transport): SentinelApi['listAlertRules'] =>
  async (options = {}) =>
    parseAlertRuleList(
      await transport.get('alert-rules/', { signal: options.signal, query: listQuery(options) }),
    )

export const getAlertRule =
  (transport: Transport): SentinelApi['getAlertRule'] =>
  async (id, options) =>
    parseAlertRuleDetail(await transport.get(rulePath(id), { signal: options?.signal }))

export const getAlertRuleOptions =
  (transport: Transport): SentinelApi['getAlertRuleOptions'] =>
  async (options) =>
    parseAlertRuleOptions(await transport.get('alert-rules/options/', { signal: options?.signal }))

export const createAlertRule =
  (transport: Transport): SentinelApi['createAlertRule'] =>
  async (input, options) =>
    parseAlertRuleDetail(
      await transport.post('alert-rules/', body(input), { signal: options?.signal }),
    )

/** A change carries the version that was read, and never a kind: a rule's kind does not change. */
export const updateAlertRule =
  (transport: Transport): SentinelApi['updateAlertRule'] =>
  async (id, patch: AlertRulePatch, options) => {
    const { version, ...fields } = patch
    return parseAlertRuleChange(
      await transport.patch(
        rulePath(id),
        { ...body({ ...fields, kind: undefined }), version },
        { signal: options?.signal },
      ),
    )
  }
