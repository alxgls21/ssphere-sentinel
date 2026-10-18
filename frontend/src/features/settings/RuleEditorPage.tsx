import { ArrowLeft } from 'lucide-react'
import { useContext, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type {
  AlertRule,
  AlertRuleChange,
  AlertRuleOptions,
  RuleEffects,
  ScopeOptions,
} from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewSearch, useViewTo } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { describeWriteFailure, summaryOf, type FormFailure } from '@/lib/forms'
import { effectsSentence, previewChange, type ChangePreview } from '@/lib/ruleChanges'
import { Panel } from '@/ui/Panel'
import { Button } from '@/ui/controls'
import { EmptyState, Notice, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { ChangeConfirm } from './ChangeConfirm'
import { RuleForm } from './RuleForm'
import {
  RULE_FIELDS,
  draftFromRule,
  effectValues,
  hasErrors,
  newDraft,
  toInput,
  toPatch,
  validate,
  type RuleDraft,
  type RuleErrors,
} from './ruleDraft'
import { NEW_RULE_PATH, rulePath } from './sections'

interface EditorProps {
  options: AlertRuleOptions
  scope: ScopeOptions
  /** The rule as last read; absent for a new one. */
  rule?: AlertRule
  /** This account may change what it sees (a new rule needs the create permission instead). */
  mayWrite: boolean
  /** The latest version is being read again. */
  reloading: boolean
  onSaved: (change: AlertRuleChange) => void
  onCreated: (id: string) => void
  onReload: () => void
}

/**
 * The form and what happens around a save: the checks made here, the server's own answer field by
 * field, a conflict (the rule changed elsewhere: nothing is overwritten, and the latest version is
 * offered), and the warning before a change that ends open incidents.
 */
function Editor({
  options,
  scope,
  rule,
  mayWrite,
  reloading,
  onSaved,
  onCreated,
  onReload,
}: EditorProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState<RuleDraft>(() =>
    rule ? draftFromRule(rule) : newDraft(options),
  )
  const [clientErrors, setClientErrors] = useState<RuleErrors>({})
  const [failure, setFailure] = useState<FormFailure | null>(null)
  const [conflict, setConflict] = useState(false)
  const [confirm, setConfirm] = useState<ChangePreview | null>(null)
  const [saving, setSaving] = useState(false)
  const summary = useRef<HTMLDivElement>(null)

  const patch = rule ? toPatch(draft, rule, options) : null
  // Invalid durations are deliberately absent from the API patch. They still need a
  // submission so validation can explain the edit instead of calling it unchanged.
  const changed = rule ? patch !== null || hasErrors(validate(draft, options)) : true
  const errors: RuleErrors = { ...clientErrors, ...(failure?.fields ?? {}) }
  const lines = summaryOf(failure)

  const edit = (next: RuleDraft) => {
    setDraft(next)
    setClientErrors({})
    setFailure(null)
    setConfirm(null)
  }

  const send = async () => {
    setSaving(true)
    setFailure(null)
    try {
      if (rule) {
        const body = toPatch(draft, rule, options)
        if (body === null) return
        const change = await api.updateAlertRule(rule.id, body)
        shell?.announce('Alert rule saved.')
        onSaved(change)
      } else {
        const created = await api.createAlertRule(toInput(draft, options))
        shell?.announce('Alert rule created.')
        onCreated(created.item.id)
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        // Someone changed the rule since it was read: nothing is overwritten, and the choice is the user's.
        setConflict(true)
      } else {
        setFailure(describeWriteFailure(error, RULE_FIELDS))
        shell?.announce('The alert rule was not saved.')
      }
      setConfirm(null)
      requestAnimationFrame(() => summary.current?.focus())
    } finally {
      setSaving(false)
    }
  }

  const submit = () => {
    const found = validate(draft, options)
    if (hasErrors(found)) {
      setClientErrors(found)
      shell?.announce('Some values are not valid.')
      requestAnimationFrame(() => summary.current?.focus())
      return
    }
    if (rule) {
      const preview = previewChange(rule, effectValues(draft), options.changeEffects)
      // A change that ends open incidents is confirmed first; one that ends none goes straight through.
      if (preview.warns) {
        setConfirm(preview)
        return
      }
    }
    void send()
  }

  const invalid = Object.entries(errors).filter(([, messages]) => (messages?.length ?? 0) > 0)

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault()
        if (mayWrite && !saving && !conflict) submit()
      }}
    >
      <div ref={summary} tabIndex={-1} className="flex flex-col gap-2 outline-none">
        {conflict ? (
          <Notice
            status="warning"
            word="CHANGED ELSEWHERE"
            live="alert"
            actions={
              <Button onClick={onReload} disabled={reloading} aria-busy={reloading}>
                {reloading ? 'Loading…' : 'Load the latest version'}
              </Button>
            }
          >
            <p className="type-body-strong">This rule was changed since you opened it.</p>
            <p>
              Your changes have not been saved, and nothing was overwritten. Load the latest version
              to see what changed and make your change again: what you typed here is discarded.
            </p>
          </Notice>
        ) : null}
        {invalid.length > 0 || lines.length > 0 ? (
          <Notice status="critical" word="NOT SAVED" live="alert">
            {invalid.length > 0 ? (
              <p>
                Some values are not valid: {invalid.map(([name]) => name).join(', ')}. Each is
                explained under its field.
              </p>
            ) : null}
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Notice>
        ) : null}
      </div>

      <RuleForm
        draft={draft}
        onChange={edit}
        options={options}
        scope={scope}
        errors={errors}
        rule={rule}
        readOnly={!mayWrite || conflict}
        busy={saving}
      />

      {confirm && rule ? (
        <ChangeConfirm
          preview={confirm}
          rule={rule.name}
          confirmLabel={
            confirm.notes.some((note) => note.closes === 'rule_disabled')
              ? 'Disable and end incidents'
              : 'Save and end incidents'
          }
          busy={saving}
          onConfirm={() => void send()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {mayWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={saving || conflict || !changed || confirm !== null}
            aria-busy={saving}
          >
            {saving ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}
          </Button>
          {rule && !changed ? (
            <span className="type-body text-fg-muted">Nothing changed yet.</span>
          ) : null}
        </div>
      ) : (
        <p className="type-body text-fg-muted">
          {rule
            ? 'You may view this rule but not change it.'
            : 'This account may not create alert rules.'}
        </p>
      )}
    </form>
  )
}

/**
 * Settings > Alert rules > a rule, or a new one. The options (what a form may offer), the customers
 * and sites (for the scope) and, for an existing rule, the rule are read from the API. A rule is
 * never deleted here: it is disabled.
 */
export default function RuleEditorPage() {
  const api = useApi()
  const { id } = useParams()
  const creating = id === undefined
  const navigate = useNavigate()
  const location = useLocation()
  const viewTo = useViewTo()
  const view = useViewSearch()
  const { capabilities } = useAuth()

  const mayOpen = creating ? capabilities.createAlertRules : capabilities.viewAlertRules
  const options = useResource<AlertRuleOptions | null>(`rule-options:${mayOpen}`, async (signal) =>
    mayOpen ? api.getAlertRuleOptions({ signal }) : null,
  )
  const scope = useResource<ScopeOptions | null>(`rule-scope:${mayOpen}`, async (signal) =>
    mayOpen ? api.getScopeOptions({ signal }) : null,
  )
  const detail = useResource(`rule:${id ?? 'new'}:${mayOpen}`, async (signal) =>
    mayOpen && id !== undefined ? api.getAlertRule(id, { signal }) : null,
  )

  // What the server answered to a save replaces what was read, until the rule is read again.
  const [saved, setSaved] = useState<{ rule: AlertRule; flash: RuleEffects | null } | null>(null)
  const back = (location.state as { list?: string } | null)?.list
  const created = (location.state as { created?: boolean } | null)?.created === true
  const rule: AlertRule | undefined = saved?.rule ?? detail.data?.item

  if (!mayOpen) {
    return (
      <div className="rounded-sm border border-border bg-panel">
        <EmptyState
          title={
            creating ? 'Not permitted to create alert rules' : 'Not permitted to see alert rules'
          }
          hint="The console offers this only to an account with the permission and the access to every customer. The server checks it on every request."
        />
      </div>
    )
  }

  const notFound =
    detail.error instanceof ApiError && detail.error.status === 404 && detail.data == null
  const forbidden = [options.error, detail.error].some(
    (error) => error instanceof ApiError && error.status === 403,
  )
  const loading = options.data == null || scope.data == null || (!creating && rule === undefined)
  const failed = options.error ?? scope.error ?? detail.error
  const reload = () => {
    setSaved(null)
    options.refetch()
    scope.refetch()
    detail.refetch()
  }

  const backLink = { pathname: '/settings/alert-rules', search: back ?? view }
  const mayWrite = creating
    ? capabilities.createAlertRules
    : capabilities.editAlertRules && (rule?.canEdit ?? false)

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <Link
          to={backLink}
          className="type-data inline-flex w-fit items-center gap-1 rounded-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          Alert rules
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="type-title">
            {creating ? (
              'New alert rule'
            ) : rule ? (
              rule.name
            ) : failed ? (
              'Alert rule'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h2>
          {rule ? (
            <>
              <StatusTag
                status={rule.enabled ? 'healthy' : 'idle'}
                word={rule.enabled ? 'ENABLED' : 'DISABLED'}
                variant="tag"
              />
              <span className="type-data text-fg-muted">
                {rule.openIncidents} open {rule.openIncidents === 1 ? 'incident' : 'incidents'}
              </span>
            </>
          ) : null}
        </div>
      </header>

      {created ? (
        <Notice status="healthy" word="CREATED" live="status">
          The rule is created. The engine starts to apply it at its next cycle.
        </Notice>
      ) : null}
      {saved ? (
        <Notice status="healthy" word="SAVED" live="status">
          {effectsSentence(saved.flash)}
        </Notice>
      ) : null}

      {notFound ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState
            title="Alert rule not found"
            hint="It does not exist, or it was removed from the admin."
          />
        </div>
      ) : forbidden ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState
            title="Not permitted"
            hint="The server refused: this account may not see alert rules."
          />
        </div>
      ) : (
        <Panel
          title="Rule"
          features="settings"
          scope="NOW"
          status={loading ? (failed ? 'error' : 'loading') : 'success'}
          error={loading ? failed : null}
          onRetry={reload}
          skeleton={<div className="h-64" />}
          className="max-w-4xl"
        >
          {options.data && scope.data && (creating || rule) ? (
            <Editor
              // A new reading (another version) starts the form from it, never from a save just shown.
              key={rule ? `${rule.id}:${rule.version}` : 'new'}
              options={options.data}
              scope={scope.data}
              rule={rule}
              mayWrite={mayWrite}
              reloading={detail.isRefreshing}
              onSaved={(change: AlertRuleChange) =>
                setSaved({ rule: change.item, flash: change.effects })
              }
              onCreated={(newId) =>
                void navigate(viewTo(rulePath(newId)), { state: { created: true, list: back } })
              }
              onReload={reload}
            />
          ) : null}
        </Panel>
      )}
    </div>
  )
}

export { NEW_RULE_PATH }
