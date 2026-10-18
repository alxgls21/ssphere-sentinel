import type {
  AlertRule,
  ChangeEffects,
  IncidentConditionHealth,
  RuleClosure,
  RuleEffects,
} from '@/api/types'
import { formatInteger } from './format'

/**
 * What a change to an alert rule does to its open incidents, read from the API's `changeEffects`
 * contract and never from a rule of the console's own. The engine applies a change at its next
 * cycle, and some changes end the rule's open incidents then: the form says so before it saves.
 */

/** The values of a rule a change can touch the open incidents with. */
export interface RuleEffectValues {
  enabled: boolean
  health: IncidentConditionHealth
  reason: string | null
  severity: string
  customerId: string | null
  siteId: string | null
}

export const valuesOf = (rule: AlertRule): RuleEffectValues => ({
  enabled: rule.enabled,
  health: rule.health,
  reason: rule.reason,
  severity: rule.severity,
  customerId:
    rule.scope.customerId && rule.scope.type === 'customer' ? rule.scope.customerId : null,
  siteId: rule.scope.siteId,
})

export interface ClosureNote {
  closes: RuleClosure
  /** Which of the open incidents: "all", or "outside the new scope" (the API's words). */
  which: string
  /** One sentence, for a warning that comes before the save. */
  text: string
}

export interface ChangePreview {
  notes: ClosureNote[]
  /** Open incidents of the rule when it was read: what a change that ends them all would end. */
  openIncidents: number
  /** Some change ends every open incident, and there are some. */
  closesAll: boolean
  /** Something ends open incidents, or could (a scope change ends those outside the new scope). */
  warns: boolean
}

/** The fields the contract names, and whether a change from `before` to `after` is one of them. */
function changed(field: string, before: RuleEffectValues, after: RuleEffectValues): boolean {
  switch (field) {
    case 'enabled':
      return before.enabled !== after.enabled
    case 'health':
      return before.health !== after.health
    case 'reason':
      return before.reason !== after.reason
    case 'severity':
      return before.severity !== after.severity
    case 'scope':
      return before.customerId !== after.customerId || before.siteId !== after.siteId
    default:
      return false
  }
}

function sentence(closes: RuleClosure, which: string, open: number): string {
  const many = `${formatInteger(open)} open ${open === 1 ? 'incident' : 'incidents'}`
  switch (closes) {
    case 'rule_disabled':
      return open > 0
        ? `Disabling the rule ends its ${many}, all of them, when the engine next runs.`
        : 'Disabling the rule ends any incident it opened. None is open now.'
    case 'rule_changed':
      return open > 0
        ? `A new condition or severity ends its ${many}, ${which === 'all' ? 'all of them' : which}: they were opened under the old one.`
        : 'A new condition or severity ends the incidents opened under the old one. None is open now.'
    case 'out_of_scope':
      return open > 0
        ? `A new scope ends the open incidents of objects ${which} (of its ${many}).`
        : 'A new scope ends the open incidents of objects outside it. None is open now.'
  }
}

/**
 * The closures a change from `before` to `after` brings, by the contract. Disabling a rule ends its
 * incidents as disabled, whatever else changes with it (the API reports that one, not both).
 */
export function previewChange(
  before: AlertRule,
  after: RuleEffectValues,
  effects: ChangeEffects,
): ChangePreview {
  const was = valuesOf(before)
  const found = new Map<RuleClosure, string>()
  for (const [field, effect] of Object.entries(effects)) {
    if (!changed(field, was, after)) continue
    // A value that closes nothing (switching a rule on) is not a closure.
    if (effect.to !== undefined && field === 'enabled' && after.enabled !== effect.to) continue
    if (!found.has(effect.closes)) found.set(effect.closes, effect.which)
  }
  if (found.has('rule_disabled')) found.delete('rule_changed')
  const open = before.openIncidents
  const notes = [...found].map(([closes, which]) => ({
    closes,
    which,
    text: sentence(closes, which, open),
  }))
  const closesAll =
    open > 0 &&
    notes.some((note) => note.closes === 'rule_disabled' || note.closes === 'rule_changed')
  return {
    notes,
    openIncidents: open,
    closesAll,
    warns: open > 0 && notes.length > 0,
  }
}

/** What a saved change did, from the API's own `effects` (what it says it will end, and how many were open). */
export function effectsSentence(effects: RuleEffects | null): string {
  if (effects === null) return 'Nothing changed: the rule is as it was.'
  const open = effects.openIncidents
  const count = `${formatInteger(open)} open ${open === 1 ? 'incident' : 'incidents'}`
  if (effects.closes.length === 0)
    return 'Saved. The engine applies it at its next cycle; it ends no incident.'
  const parts = effects.closes.map((closes) => {
    switch (closes) {
      case 'rule_disabled':
        return 'the rule’s incidents end, as it is disabled'
      case 'rule_changed':
        return 'the rule’s incidents end, as its condition or severity changed'
      case 'out_of_scope':
        return 'the open incidents of objects outside the new scope end'
    }
  })
  return `Saved. At the engine’s next cycle ${parts.join(', and ')} (${count} when it was changed${effects.closesAll ? ', all of them' : ''}).`
}
