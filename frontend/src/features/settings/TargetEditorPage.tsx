import { useContext, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type {
  AgentOption,
  ScopeOptions,
  TargetConfig,
  TargetDetail,
  TargetProtocol,
} from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewSearch, useViewTo } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { useSaveForm } from '@/hooks/useSaveForm'
import { CodeBlock } from '@/ui/CodeBlock'
import { DeleteConfirm } from '@/ui/DeleteConfirm'
import { FormNotice } from '@/ui/FormNotice'
import { Panel } from '@/ui/Panel'
import { Button, Checkbox, FieldInput, FieldSelect, FieldTextArea } from '@/ui/controls'
import { EmptyState, Notice, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { BackLink, NotPermitted } from './AdminParts'
import { useArrivalState, useListBack } from './adminHooks'
import { agentChoices, siteChoices } from './adminModel'
import { networkTargetPath, targetEditorPath } from './sections'
import {
  NEW_TARGET,
  PROTOCOL_CHOICES,
  TARGET_FIELDS,
  TARGET_LIMITS,
  agentEntryText,
  targetDraft,
  targetInput,
  targetPatch,
  validateTarget,
  type TargetDraft,
} from './targetsModel'

/** Every agent the account may choose from, in one page: a fleet with more has the search of the Network screen. */
const AGENT_CHOICES = 200

interface EditorProps {
  config?: TargetConfig
  scope: ScopeOptions
  agents: readonly AgentOption[]
  onSaved: (detail: TargetDetail) => void
  onCreated: (detail: TargetDetail) => void
}

/** The form of a target: what to probe, how, from which agent, and where it is placed. */
function Editor({ config, scope, agents, onSaved, onCreated }: EditorProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState<TargetDraft>(() => (config ? targetDraft(config) : NEW_TARGET))
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(TARGET_FIELDS, shell?.announce, summary)
  const changed = config ? targetPatch(draft, config) !== null : true
  const locked = form.saving

  const edit = (changes: Partial<TargetDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    form.touched()
  }

  const submit = () =>
    form.submit(
      validateTarget(draft),
      async () => {
        if (config) {
          const body = targetPatch(draft, config)
          if (body === null) return
          onSaved(await api.updateTarget(config.id, body))
          shell?.announce('Target saved.')
        } else {
          onCreated(await api.createTarget(targetInput(draft)))
          shell?.announce('Target created.')
        }
      },
      { failed: 'The target was not saved.' },
    )

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      aria-busy={locked}
      onSubmit={(event) => {
        event.preventDefault()
        if (!locked) void submit()
      }}
    >
      <FormNotice ref={summary} invalid={form.invalid} lines={form.lines} />
      <div className="grid gap-4 md:grid-cols-2">
        <FieldInput
          label="Name"
          value={draft.name}
          onChange={(name) => edit({ name })}
          error={form.errors.name}
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false, required: true }}
          hint={`How the console names it; up to ${TARGET_LIMITS.name} characters.`}
        />
        <FieldInput
          label="Address"
          value={draft.address}
          onChange={(address) => edit({ address })}
          error={form.errors.address}
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false, required: true }}
          hint="A host name or an IP address the agent can reach."
        />
        <FieldSelect
          label="Protocol"
          value={draft.protocol}
          onChange={(protocol: TargetProtocol) => edit({ protocol })}
          options={PROTOCOL_CHOICES}
          error={form.errors.protocol}
          disabled={locked}
          hint="ICMP pings it; TCP connects to a port."
        />
        <FieldInput
          label="Port"
          value={draft.protocol === 'tcp' ? draft.port : ''}
          onChange={(port) => edit({ port })}
          error={form.errors.port}
          input={{
            disabled: locked || draft.protocol !== 'tcp',
            inputMode: 'numeric',
            autoComplete: 'off',
          }}
          hint={draft.protocol === 'tcp' ? '1 to 65535.' : 'ICMP targets have no port.'}
        />
        <FieldInput
          label="Interval (seconds)"
          value={draft.intervalSeconds}
          onChange={(intervalSeconds) => edit({ intervalSeconds })}
          error={form.errors.intervalSeconds}
          input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
          hint={`How often the agent probes it: ${TARGET_LIMITS.interval[0]} to ${TARGET_LIMITS.interval[1]}.`}
        />
        <FieldInput
          label="Timeout (seconds)"
          value={draft.timeoutSeconds}
          onChange={(timeoutSeconds) => edit({ timeoutSeconds })}
          error={form.errors.timeoutSeconds}
          input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
          hint={`Per probe: ${TARGET_LIMITS.timeout[0]} to ${TARGET_LIMITS.timeout[1]}.`}
        />
        <FieldSelect
          label="Site"
          value={draft.siteId}
          onChange={(siteId) => edit({ siteId })}
          options={siteChoices(scope, 'No site (seen by accounts with every customer only)')}
          error={form.errors.siteId}
          disabled={locked}
          hint="Decides who sees the target: the accounts granted the site or its customer."
        />
        <FieldSelect
          label="Agent"
          value={draft.agentId}
          onChange={(agentId) => edit({ agentId })}
          options={agentChoices(agents)}
          error={form.errors.agentId}
          disabled={locked}
          hint="The server whose agent probes it. The agent also needs the entry in its targets file."
        />
        <FieldInput
          label="Expected SLA (%)"
          value={draft.expectedSlaPercent}
          onChange={(expectedSlaPercent) => edit({ expectedSlaPercent })}
          error={form.errors.expectedSlaPercent}
          input={{ disabled: locked, inputMode: 'decimal', autoComplete: 'off' }}
          hint="Informational, for reports: 0 to 100, two decimals."
        />
        <FieldInput
          label="Circuit id"
          value={draft.circuitId}
          onChange={(circuitId) => edit({ circuitId })}
          error={form.errors.circuitId}
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false }}
          hint="Optional, for reports."
        />
        <FieldTextArea
          label="Customer label"
          value={draft.customerLabel}
          onChange={(customerLabel) => edit({ customerLabel })}
          error={form.errors.customerLabel}
          textarea={{ disabled: locked, rows: 2 }}
          hint="Optional free text for reports. It says nothing about who sees the target: the site does."
        />
        <Checkbox
          label="Enabled"
          description="A disabled target is probed by nobody, reads as idle, and an incident of it ends."
          checked={draft.enabled}
          onChange={(enabled) => edit({ enabled })}
          disabled={locked}
          error={form.errors.enabled}
          className="self-end"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={locked || !changed} aria-busy={locked}>
          {locked ? 'Saving…' : config ? 'Save changes' : 'Create target'}
        </Button>
        {config && !changed ? (
          <span className="type-body text-fg-muted">Nothing changed yet.</span>
        ) : null}
      </div>
    </form>
  )
}

/**
 * Settings > Network targets > one target, or a new one: the form, the entry the agent's targets
 * file needs for it (copied from here), and its deletion with its history. The agent itself reads
 * only its own file: a target saved here is probed once its entry is on the host.
 */
export default function TargetEditorPage() {
  const api = useApi()
  const { id } = useParams()
  const creating = id === undefined
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const view = useViewSearch()
  const shell = useContext(ShellContext)
  const { capabilities } = useAuth()
  const may = capabilities.manageTargets
  const back = useListBack('/settings/targets', view)
  const arrival = useArrivalState<{ created?: boolean }>()

  const detail = useResource(`target-config:${id ?? 'new'}:${may}`, async (signal) =>
    may && id !== undefined ? api.getTarget(id, { signal }) : null,
  )
  const scope = useResource<ScopeOptions | null>(`target-scope:${may}`, async (signal) =>
    may ? api.getScopeOptions({ signal }) : null,
  )
  const agents = useResource(`target-agents:${may}`, async (signal) =>
    may ? api.listAgents({ pageSize: AGENT_CHOICES, signal }) : null,
  )
  const [saved, setSaved] = useState<{ at: string | undefined; detail: TargetDetail } | null>(null)
  if (saved !== null && saved.at !== id) setSaved(null)
  const current = saved !== null && saved.at === id ? saved.detail : (detail.data ?? undefined)
  const config = current?.item.target

  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  if (!may) {
    return (
      <NotPermitted
        what="change network targets"
        hint="The console offers this only to an account that may change alert rules and holds the admin's permissions on network targets, with access to every customer. The server checks it on every request."
      />
    )
  }

  const notFound =
    detail.error instanceof ApiError && detail.error.status === 404 && current === undefined
  const loading = scope.data == null || agents.data == null || (!creating && config === undefined)
  const failed = scope.error ?? agents.error ?? detail.error
  const reload = () => {
    scope.refetch()
    agents.refetch()
    detail.refetch()
  }

  const remove = async () => {
    if (!config) return
    setDeleting(true)
    setProblem(null)
    try {
      const gone = await api.deleteTarget(config.id)
      shell?.announce(`Target “${gone.deleted.name}” deleted.`)
      void navigate(viewTo('/settings/targets'), {
        replace: true,
        state: { deleted: gone.deleted.name },
      })
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'The target could not be deleted: the server could not be reached.',
      )
      shell?.announce('The target was not deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <BackLink to={back}>Network targets</BackLink>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="type-title">
            {creating ? (
              'New target'
            ) : config ? (
              config.name
            ) : failed ? (
              'Target'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h2>
          {config ? (
            <>
              <StatusTag
                status={config.enabled ? 'healthy' : 'idle'}
                word={config.enabled ? 'ENABLED' : 'DISABLED'}
                variant="tag"
              />
              <Link
                to={viewTo(networkTargetPath(config.id))}
                className="type-data text-primary underline underline-offset-2"
              >
                Open in Network
              </Link>
            </>
          ) : null}
        </div>
      </header>

      {arrival.created && !saved ? (
        <Notice status="healthy" word="CREATED" live="status">
          The target is created. Copy its entry below into the targets file of the agent that probes
          it.
        </Notice>
      ) : null}
      {saved ? (
        <Notice status="healthy" word="SAVED" live="status">
          The target is saved. If the address, protocol, port, interval or timeout changed, update
          the entry in the agent's targets file too.
        </Notice>
      ) : null}

      {notFound ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState title="Target not found" hint="It does not exist, or it was deleted." />
        </div>
      ) : (
        <Panel
          title="Target"
          features="settings"
          scope="NOW"
          status={loading ? (failed ? 'error' : 'loading') : 'success'}
          error={loading ? failed : null}
          onRetry={reload}
          skeleton={<div className="h-64" />}
          className="max-w-4xl"
        >
          {scope.data && agents.data && (creating || config) ? (
            <Editor
              key={config ? `${config.id}:${current?.generatedAt ?? ''}` : 'new'}
              config={config}
              scope={scope.data}
              agents={agents.data.items}
              onSaved={(next) => setSaved({ at: id, detail: next })}
              onCreated={(next) =>
                void navigate(viewTo(targetEditorPath(next.item.target.id)), {
                  state: { created: true, list: back.search },
                })
              }
            />
          ) : null}
        </Panel>
      )}

      {config && current ? (
        <>
          <Panel title="Agent targets file" features="settings" scope="NOW" className="max-w-4xl">
            <CodeBlock
              title="Entry for this target"
              what="Entry"
              text={agentEntryText(current.agentEntry)}
            >
              One object of the <code className="type-data">targets</code> list of the agent's
              targets file (SENTINEL_NETWORK_TARGETS_FILE on the host; see
              agent/network_targets.example.json). The agent reads the file at start: restart it
              after a change.
            </CodeBlock>
          </Panel>

          <Panel title="Delete" features="settings" scope="NOW" className="max-w-4xl">
            {confirm ? (
              <DeleteConfirm
                kind="target"
                name={config.name}
                busy={deleting}
                problem={problem}
                onConfirm={() => void remove()}
                onCancel={() => setConfirm(false)}
              >
                <p>
                  The target goes with its whole measurement history; an incident of it ends at the
                  engine's next cycle.
                </p>
                <p>
                  Remove its entry from the agent's targets file too, or the agent keeps probing an
                  address nobody records.
                </p>
              </DeleteConfirm>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => setConfirm(true)}>Delete target</Button>
                <span className="type-body text-fg-muted">
                  Its measurements go with it. To stop probing it for a while, disable it instead.
                </span>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}
