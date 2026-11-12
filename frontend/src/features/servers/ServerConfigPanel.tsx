import { useContext, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { ScopeOptions, ServerDetail, ServerListItem } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewTo } from '@/app/viewSearch'
import type { Resource } from '@/hooks/useResource'
import { useResource } from '@/hooks/useResource'
import { useSaveForm } from '@/hooks/useSaveForm'
import { EMPTY } from '@/lib/format'
import { DeleteConfirm } from '@/ui/DeleteConfirm'
import { Fact } from '@/ui/Fact'
import { FormNotice } from '@/ui/FormNotice'
import { Panel } from '@/ui/Panel'
import { Button, FieldInput, FieldSelect, FieldTextArea } from '@/ui/controls'
import {
  LIMITS,
  SERVER_FIELDS,
  draftFromServer,
  siteChoices,
  toPatch,
  validate,
  type ServerDraft,
} from './serverDraft'

interface ServerConfigPanelProps {
  index: number
  resource: Resource<ServerDetail>
  className?: string
}

/** The form that changes a server: the same fields as adding one, saved as a change of only what differs. */
function EditForm({
  item,
  scope,
  onSaved,
  onCancel,
}: {
  item: ServerListItem
  scope: ScopeOptions
  onSaved: () => void
  onCancel: () => void
}) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState<ServerDraft>(() => draftFromServer(item.server))
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(SERVER_FIELDS, shell?.announce, summary)
  const taken =
    form.failure?.code === 'server_exists' && form.failure.message ? [form.failure.message] : null
  const errors = { ...form.errors, ...(taken ? { name: taken } : {}) }
  const lines = taken ? [] : form.lines
  const changed = toPatch(draft, item.server) !== null
  const locked = form.saving

  const edit = (changes: Partial<ServerDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    form.touched()
  }

  const submit = () =>
    form.submit(
      validate(draft),
      async () => {
        const body = toPatch(draft, item.server)
        if (body === null) return
        await api.updateServer(item.server.id, body)
        shell?.announce('Server saved.')
        onSaved()
      },
      { failed: 'The server was not saved.' },
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
      <FormNotice
        ref={summary}
        invalid={Object.keys(errors).filter(
          (name) => (errors[name as keyof typeof errors]?.length ?? 0) > 0,
        )}
        lines={lines}
      />
      <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
        <FieldInput
          label="Name"
          value={draft.name}
          onChange={(name) => edit({ name })}
          error={errors.name}
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false, required: true }}
          hint={`How the console names the host. Unique; up to ${LIMITS.name} characters.`}
        />
        <FieldInput
          label="Hostname"
          value={draft.hostname}
          onChange={(hostname) => edit({ hostname })}
          error={errors.hostname}
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false }}
          hint="How the host is known on the network. Blank: the name."
        />
        <FieldSelect
          label="Site"
          value={draft.siteId}
          onChange={(siteId) => edit({ siteId })}
          options={siteChoices(scope)}
          error={errors.siteId}
          disabled={locked}
          hint="Decides who sees the server: the accounts granted the site or its customer."
        />
        <FieldInput
          label="IP address"
          value={draft.ipAddress}
          onChange={(ipAddress) => edit({ ipAddress })}
          error={errors.ipAddress}
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false }}
          hint="Optional. IPv4 or IPv6."
        />
        <FieldInput
          label="Operating system"
          value={draft.operatingSystem}
          onChange={(operatingSystem) => edit({ operatingSystem })}
          error={errors.operatingSystem}
          input={{ disabled: locked, autoComplete: 'off' }}
          hint="Optional, for example Debian 12."
        />
        <FieldTextArea
          label="Description"
          value={draft.description}
          onChange={(description) => edit({ description })}
          error={errors.description}
          textarea={{ disabled: locked }}
          hint="Optional."
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={locked || !changed} aria-busy={locked}>
          {locked ? 'Saving…' : 'Save changes'}
        </Button>
        <Button onClick={onCancel} disabled={locked}>
          Cancel
        </Button>
        {!changed ? <span className="type-body text-fg-muted">Nothing changed yet.</span> : null}
      </div>
    </form>
  )
}

/**
 * [n] Configuration: what the server is in the inventory (its name, hostname, address, system,
 * description and site), changed here by an account that may change hosts, and deleted here by one
 * that may delete them: with its agent (whose token stops working at once), its telemetry and its
 * containers, after the server's name is typed back. Its measurements, targets and devices stay.
 */
export function ServerConfigPanel({ index, resource, className }: ServerConfigPanelProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const { capabilities } = useAuth()
  const mayEdit = capabilities.editServers
  const mayDelete = capabilities.deleteServers
  const item = resource.data?.item
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const scope = useResource<ScopeOptions | null>(
    `server-config-scope:${mayEdit && editing}`,
    async (signal) => (mayEdit && editing ? api.getScopeOptions({ signal }) : null),
  )

  const remove = async () => {
    if (!item) return
    setDeleting(true)
    setProblem(null)
    try {
      const gone = await api.deleteServer(item.server.id)
      shell?.announce(`Server “${gone.deleted.name}” deleted.`)
      void navigate(viewTo('/servers'), { replace: true, state: { deleted: gone.deleted } })
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'The server could not be deleted: the server could not be reached.',
      )
      shell?.announce('The server was not deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Panel
      index={index}
      title="Configuration"
      features="servers"
      scope="NOW"
      className={className}
      status={resource.status}
      error={resource.error}
      updatedAt={resource.updatedAt}
      onRetry={resource.refetch}
      skeleton={<div className="h-16" />}
    >
      {item ? (
        editing ? (
          <Panel
            title="Change the server"
            features="servers"
            scope="NOW"
            status={scope.data ? 'success' : scope.error ? 'error' : 'loading'}
            error={scope.data ? null : scope.error}
            onRetry={scope.refetch}
            skeleton={<div className="h-40" />}
          >
            {scope.data ? (
              <EditForm
                item={item}
                scope={scope.data}
                onSaved={() => {
                  setEditing(false)
                  resource.refetch()
                }}
                onCancel={() => setEditing(false)}
              />
            ) : null}
          </Panel>
        ) : (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-3">
              <Fact label="Name">{item.server.name}</Fact>
              <Fact label="Hostname">{item.server.hostname}</Fact>
              <Fact label="IP address">{item.server.ipAddress ?? EMPTY}</Fact>
              <Fact label="Operating system">{item.server.operatingSystem || EMPTY}</Fact>
              <Fact label="Site">
                {item.siteName && item.customerName
                  ? `${item.customerName} / ${item.siteName}`
                  : 'No site'}
              </Fact>
              <Fact label="Description">{item.server.description || EMPTY}</Fact>
            </dl>
            {confirm ? (
              <DeleteConfirm
                kind="server"
                name={item.server.name}
                busy={deleting}
                problem={problem}
                onConfirm={() => void remove()}
                onCancel={() => setConfirm(false)}
              >
                <p>
                  The server goes with its agent (whose token stops working at once: the host's
                  agent fails until it is removed), its latest telemetry and its history, and the
                  containers it reported.
                </p>
                <p>
                  Its network measurements are kept without their agent; the targets and devices
                  assigned to its agent lose it, and nothing measures them until another agent is
                  assigned. Its incidents end at the engine's next cycle.
                </p>
              </DeleteConfirm>
            ) : mayEdit || mayDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                {mayEdit ? <Button onClick={() => setEditing(true)}>Edit</Button> : null}
                {mayDelete ? <Button onClick={() => setConfirm(true)}>Delete server</Button> : null}
              </div>
            ) : (
              <p className="type-body text-fg-muted">
                This account may not change or delete hosts: the console offers that to an account
                that may change alert rules and holds the admin's permissions on servers.
              </p>
            )}
          </div>
        )
      ) : null}
    </Panel>
  )
}
