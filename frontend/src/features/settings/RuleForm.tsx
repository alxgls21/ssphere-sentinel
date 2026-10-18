import type { AlertRule, AlertRuleOptions, ScopeOptions } from '@/api/types'
import { formatDuration } from '@/lib/format'
import { HEALTH_CONDITION_TEXT, reasonText } from '@/lib/incidents'
import { Checkbox, FieldInput, FieldSelect, FieldTextArea, RadioGroup } from '@/ui/controls'
import {
  conditionsOf,
  reasonsOf,
  withHealth,
  withKind,
  withScopeType,
  type RuleDraft,
  type RuleErrors,
} from './ruleDraft'
import { KIND_LABEL } from './rulesModel'

interface RuleFormProps {
  draft: RuleDraft
  onChange: (draft: RuleDraft) => void
  options: AlertRuleOptions
  scope: ScopeOptions
  errors: RuleErrors
  /** The rule being edited; undefined for a new one. Its kind cannot change. */
  rule?: AlertRule
  /** This account may view the rule but not change it. */
  readOnly: boolean
  /** A change is being saved. */
  busy: boolean
}

/** Whole seconds typed, said as a duration beside the field: "120 → 2m 0s". */
function durationHint(value: string): string | undefined {
  return /^\d{1,7}$/.test(value.trim()) ? formatDuration(Number(value)) : undefined
}

const SCOPE_CHOICES = [
  {
    value: 'all',
    label: 'All customers and sites',
    hint: 'Every object, including those on no site.',
  },
  { value: 'customer', label: 'One customer', hint: 'Objects on any of that customer’s sites.' },
  { value: 'site', label: 'One site', hint: 'Objects on that site only.' },
] as const

/**
 * The fields of an alert rule. What can be chosen is the API's: the conditions of a kind, the
 * reasons of a condition, the limits of the numbers. Errors sit under the field they are about,
 * from the checks made here and from the server's own answer. The kind of a rule that exists never
 * changes, and a rule an account may only view is shown with its fields locked.
 */
export function RuleForm({
  draft,
  onChange,
  options,
  scope,
  errors,
  rule,
  readOnly,
  busy,
}: RuleFormProps) {
  const locked = readOnly || busy
  const conditions = conditionsOf(options, draft.kind)
  const reasons = reasonsOf(options, draft.kind, draft.health)
  const customers = new Map(scope.customers.map((customer) => [customer.id, customer.name]))
  const patch = (changes: Partial<RuleDraft>) => onChange({ ...draft, ...changes })

  return (
    <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
      {rule?.key ? (
        <p className="type-body md:col-span-2 rounded-sm border border-border bg-raised px-3 py-2 text-fg-muted">
          A rule Sentinel installed: its key <code className="type-data text-fg">{rule.key}</code>{' '}
          is read-only. Everything else can be changed, and an incident it opened keeps this rule.
        </p>
      ) : null}

      <FieldInput
        label="Name"
        value={draft.name}
        onChange={(name) => patch({ name })}
        error={errors.name}
        className="md:col-span-2"
        input={{
          disabled: locked,
          autoComplete: 'off',
          spellCheck: false,
          required: true,
        }}
        hint={`Unique, whatever the case. Up to ${options.limits.nameMaxLength} characters.`}
      />
      <FieldTextArea
        label="Description"
        value={draft.description}
        onChange={(description) => patch({ description })}
        error={errors.description}
        className="md:col-span-2"
        textarea={{ disabled: locked }}
        hint="Shown with every incident this rule opens. Optional."
      />

      <FieldSelect
        label="Kind of object"
        value={draft.kind}
        onChange={(kind) => onChange(withKind(draft, options, kind))}
        options={options.kinds.map((kind) => ({ value: kind.value, label: kind.label }))}
        error={errors.kind}
        disabled={locked || rule !== undefined}
        hint={
          rule
            ? `Kind: ${KIND_LABEL[rule.kind]}. A rule’s kind cannot be changed: disable it and add a new rule.`
            : 'What the rule watches. It cannot be changed afterwards.'
        }
      />
      <FieldSelect
        label="Fires when the health is"
        value={draft.health}
        onChange={(health) => onChange(withHealth(draft, options, health))}
        options={conditions.map((condition) => ({
          value: condition.health,
          label: condition.label || HEALTH_CONDITION_TEXT[condition.health],
        }))}
        error={errors.health}
        disabled={locked}
        hint="Warning also fires on critical."
      />
      <FieldSelect
        label="Only for this reason"
        value={draft.reason}
        onChange={(reason) => patch({ reason })}
        options={[
          { value: '', label: 'Any reason' },
          ...reasons.map((reason) => ({
            value: reason,
            label: reasonText(draft.kind, reason) ?? reason,
          })),
        ]}
        error={errors.reason}
        disabled={locked}
        hint="What the console reports as the cause. The choices are what this kind and condition can have."
      />
      <FieldSelect
        label="Severity of the incident"
        value={draft.severity}
        onChange={(severity) => patch({ severity })}
        options={options.severities.map((severity) => ({
          value: severity.value,
          label: severity.label,
        }))}
        error={errors.severity}
        disabled={locked}
      />

      <FieldInput
        label="Activation delay (seconds)"
        value={draft.activationSeconds}
        onChange={(activationSeconds) => patch({ activationSeconds })}
        error={errors.activationSeconds}
        input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
        hint={`How long the condition must hold before an incident opens${durationHint(draft.activationSeconds) ? `: ${durationHint(draft.activationSeconds)}` : ''}.`}
      />
      <FieldInput
        label="Recovery delay (seconds)"
        value={draft.recoverySeconds}
        onChange={(recoverySeconds) => patch({ recoverySeconds })}
        error={errors.recoverySeconds}
        input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
        hint={`How long the condition must stay clear before the incident recovers${durationHint(draft.recoverySeconds) ? `: ${durationHint(draft.recoverySeconds)}` : ''}.`}
      />

      <RadioGroup
        legend="Scope"
        name="scope"
        value={draft.scopeType}
        onChange={(scopeType) => onChange(withScopeType(draft, scopeType))}
        choices={SCOPE_CHOICES}
        disabled={locked}
        className="md:col-span-2"
      />
      {draft.scopeType === 'customer' ? (
        <FieldSelect
          label="Customer"
          value={draft.customerId}
          onChange={(customerId) => patch({ customerId })}
          options={[
            { value: '', label: 'Choose a customer…' },
            ...scope.customers.map((customer) => ({ value: customer.id, label: customer.name })),
          ]}
          error={errors.customerId}
          disabled={locked}
        />
      ) : null}
      {draft.scopeType === 'site' ? (
        <FieldSelect
          label="Site"
          value={draft.siteId}
          onChange={(siteId) => patch({ siteId })}
          options={[
            { value: '', label: 'Choose a site…' },
            ...scope.sites.map((site) => ({
              value: site.id,
              label: `${customers.get(site.customerId) ?? 'Unknown customer'} / ${site.name}`,
            })),
          ]}
          error={errors.siteId}
          disabled={locked}
        />
      ) : null}

      <Checkbox
        label="Enabled"
        description="A disabled rule opens no incident. Disabling it ends its open incidents."
        checked={draft.enabled}
        disabled={locked}
        onChange={(enabled) => patch({ enabled })}
        error={errors.enabled}
        className="md:col-span-2"
      />
    </div>
  )
}
