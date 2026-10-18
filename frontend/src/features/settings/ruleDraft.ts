import type {
  AlertRule,
  AlertRuleInput,
  AlertRuleOptions,
  AlertRulePatch,
  AlertSeverity,
  IncidentConditionHealth,
  IncidentEntityKind,
  RuleConditionOption,
  RuleScopeType,
} from '@/api/types'
import type { RuleEffectValues } from '@/lib/ruleChanges'

/**
 * The alert rule form, as data: what the fields hold while the user edits, what is checked before
 * anything is sent, and what is sent. The kinds, conditions, reasons, limits and defaults are the
 * API's (`alert-rules/options/`): nothing is assumed here. The server checks everything again, and
 * its answer, field by field, is what finally decides.
 */

export interface RuleDraft {
  name: string
  description: string
  enabled: boolean
  kind: IncidentEntityKind
  health: IncidentConditionHealth
  /** An empty string is "any reason". */
  reason: string
  severity: AlertSeverity
  /** Seconds, as typed. */
  activationSeconds: string
  recoverySeconds: string
  scopeType: RuleScopeType
  /** Empty: none chosen. */
  customerId: string
  siteId: string
}

/** The fields an error can be shown under; the others are general problems of the form. */
export const RULE_FIELDS = [
  'name',
  'description',
  'enabled',
  'kind',
  'health',
  'reason',
  'severity',
  'activationSeconds',
  'recoverySeconds',
  'customerId',
  'siteId',
] as const

export type RuleErrors = Partial<Record<string, readonly string[]>>

export const conditionsOf = (
  options: AlertRuleOptions,
  kind: IncidentEntityKind,
): RuleConditionOption[] => options.kinds.find((entry) => entry.value === kind)?.conditions ?? []

export const reasonsOf = (
  options: AlertRuleOptions,
  kind: IncidentEntityKind,
  health: IncidentConditionHealth,
): string[] => conditionsOf(options, kind).find((entry) => entry.health === health)?.reasons ?? []

/** A form to start from: the first kind, its first condition, the first severity, the defaults the API lists. */
export function newDraft(options: AlertRuleOptions): RuleDraft {
  const kind = options.kinds[0]?.value ?? 'server'
  return {
    name: '',
    description: '',
    enabled: options.defaults.enabled,
    kind,
    health: conditionsOf(options, kind)[0]?.health ?? 'critical',
    reason: '',
    severity: options.severities[0]?.value ?? 'critical',
    activationSeconds: String(options.defaults.activationSeconds),
    recoverySeconds: String(options.defaults.recoverySeconds),
    scopeType: 'all',
    customerId: '',
    siteId: '',
  }
}

export function draftFromRule(rule: AlertRule): RuleDraft {
  return {
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    kind: rule.kind,
    health: rule.health,
    reason: rule.reason ?? '',
    severity: rule.severity,
    activationSeconds: String(rule.activationSeconds),
    recoverySeconds: String(rule.recoverySeconds),
    scopeType: rule.scope.type,
    // A site's own customer is kept to narrow the list of sites; it is not what the rule is for.
    customerId: rule.scope.customerId ?? '',
    siteId: rule.scope.siteId ?? '',
  }
}

/** A new kind starts its condition over: what can fire is the kind's own. */
export function withKind(
  draft: RuleDraft,
  options: AlertRuleOptions,
  kind: IncidentEntityKind,
): RuleDraft {
  return {
    ...draft,
    kind,
    health: conditionsOf(options, kind)[0]?.health ?? draft.health,
    reason: '',
  }
}

/** A new health keeps the reason only if it can fire it. */
export function withHealth(
  draft: RuleDraft,
  options: AlertRuleOptions,
  health: IncidentConditionHealth,
): RuleDraft {
  const keep = reasonsOf(options, draft.kind, health).includes(draft.reason)
  return { ...draft, health, reason: keep ? draft.reason : '' }
}

export function withScopeType(draft: RuleDraft, scopeType: RuleScopeType): RuleDraft {
  return { ...draft, scopeType, ...(scopeType === 'all' ? { customerId: '', siteId: '' } : {}) }
}

function seconds(value: string, max: number): number | null {
  const text = value.trim()
  if (!/^\d{1,7}$/.test(text)) return null
  const found = Number(text)
  return found <= max ? found : null
}

/** What can be told wrong before anything is sent. A draft with no errors may still be refused by the server. */
export function validate(draft: RuleDraft, options: AlertRuleOptions): RuleErrors {
  const errors: Record<string, string[]> = {}
  const { limits } = options
  const name = draft.name.trim()
  if (name === '') errors.name = ['Give the rule a name.']
  else if (name.length > limits.nameMaxLength) {
    errors.name = [`At most ${limits.nameMaxLength} characters.`]
  }
  if (draft.description.length > limits.descriptionMaxLength) {
    errors.description = [`At most ${limits.descriptionMaxLength} characters.`]
  }
  const conditions = conditionsOf(options, draft.kind)
  if (!conditions.some((entry) => entry.health === draft.health)) {
    errors.health = ['Choose a condition this kind of object can have.']
  } else if (
    draft.reason !== '' &&
    !reasonsOf(options, draft.kind, draft.health).includes(draft.reason)
  ) {
    errors.reason = ['Choose one of the reasons offered, or any reason.']
  }
  const range = `Enter a whole number of seconds from 0 to ${limits.maxDurationSeconds}.`
  if (seconds(draft.activationSeconds, limits.maxDurationSeconds) === null) {
    errors.activationSeconds = [range]
  }
  if (seconds(draft.recoverySeconds, limits.maxDurationSeconds) === null) {
    errors.recoverySeconds = [range]
  }
  if (draft.scopeType === 'customer' && draft.customerId === '')
    errors.customerId = ['Choose a customer.']
  if (draft.scopeType === 'site' && draft.siteId === '') errors.siteId = ['Choose a site.']
  return errors
}

export const hasErrors = (errors: RuleErrors): boolean => Object.keys(errors).length > 0

/** The scope as the API takes it: at most one of the two. */
function scopeBody(draft: RuleDraft): { customerId: string | null; siteId: string | null } {
  return {
    customerId: draft.scopeType === 'customer' ? draft.customerId : null,
    siteId: draft.scopeType === 'site' ? draft.siteId : null,
  }
}

/** A new rule's body. Call it on a draft with no errors. */
export function toInput(draft: RuleDraft, options: AlertRuleOptions): AlertRuleInput {
  return {
    name: draft.name.trim(),
    description: draft.description,
    enabled: draft.enabled,
    kind: draft.kind,
    health: draft.health,
    reason: draft.reason === '' ? null : draft.reason,
    severity: draft.severity,
    activationSeconds: seconds(draft.activationSeconds, options.limits.maxDurationSeconds) ?? 0,
    recoverySeconds: seconds(draft.recoverySeconds, options.limits.maxDurationSeconds) ?? 0,
    ...scopeBody(draft),
  }
}

/** The scope a rule has now, as the same two ids a draft would send. */
function ruleScope(rule: AlertRule): { customerId: string | null; siteId: string | null } {
  return {
    customerId: rule.scope.type === 'customer' ? rule.scope.customerId : null,
    siteId: rule.scope.type === 'site' ? rule.scope.siteId : null,
  }
}

/**
 * What changed from `rule`: only those fields, and the version that was read. Null when nothing did.
 * The kind never goes out: it cannot change. The scope goes out whole (both ids) when either differs.
 */
export function toPatch(
  draft: RuleDraft,
  rule: AlertRule,
  options: AlertRuleOptions,
): AlertRulePatch | null {
  const patch: Omit<AlertRulePatch, 'version'> = {}
  if (draft.name.trim() !== rule.name) patch.name = draft.name.trim()
  if (draft.description !== rule.description) patch.description = draft.description
  if (draft.enabled !== rule.enabled) patch.enabled = draft.enabled
  if (draft.health !== rule.health) patch.health = draft.health
  if ((draft.reason === '' ? null : draft.reason) !== rule.reason) {
    patch.reason = draft.reason === '' ? null : draft.reason
  }
  if (draft.severity !== rule.severity) patch.severity = draft.severity
  const activation = seconds(draft.activationSeconds, options.limits.maxDurationSeconds)
  if (activation !== null && activation !== rule.activationSeconds)
    patch.activationSeconds = activation
  const recovery = seconds(draft.recoverySeconds, options.limits.maxDurationSeconds)
  if (recovery !== null && recovery !== rule.recoverySeconds) patch.recoverySeconds = recovery
  const scope = scopeBody(draft)
  const was = ruleScope(rule)
  if (scope.customerId !== was.customerId || scope.siteId !== was.siteId)
    Object.assign(patch, scope)
  return Object.keys(patch).length === 0 ? null : { ...patch, version: rule.version }
}

/** The values a change is judged by, for the preview of what it would end. */
export function effectValues(draft: RuleDraft): RuleEffectValues {
  const scope = scopeBody(draft)
  return {
    enabled: draft.enabled,
    health: draft.health,
    reason: draft.reason === '' ? null : draft.reason,
    severity: draft.severity,
    customerId: scope.customerId,
    siteId: scope.siteId,
  }
}
