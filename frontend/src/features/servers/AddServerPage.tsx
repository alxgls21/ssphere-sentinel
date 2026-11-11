import { ArrowLeft } from 'lucide-react'
import { useContext, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { AgentEnrollment as Enrollment, ScopeOptions, ServerDetail } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewSearch, useViewTo } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { describeWriteFailure, summaryOf, type FormFailure } from '@/lib/forms'
import { serverPath } from '@/lib/paths'
import { Panel } from '@/ui/Panel'
import { Button, FieldInput, FieldSelect, FieldTextArea } from '@/ui/controls'
import { EmptyState, Notice } from '@/ui/states'
import { AgentEnrollment } from './AgentEnrollment'
import {
  EMPTY_DRAFT,
  LIMITS,
  SERVER_FIELDS,
  hasErrors,
  siteChoices,
  toInput,
  validate,
  type ServerDraft,
  type ServerErrors,
} from './serverDraft'

/**
 * Servers > Add server: the form (the name, and where the host is placed), then, once the server
 * and its agent exist, the token shown once with the installation commands. The token lives in
 * this page's state only: Done, or leaving the page, forgets it, and Done replaces this page in
 * the history with the server's own page, so Back never returns to it.
 */
export default function AddServerPage() {
  const api = useApi()
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const view = useViewSearch()
  const shell = useContext(ShellContext)
  const { capabilities } = useAuth()
  const permitted = capabilities.manageServers
  const scope = useResource<ScopeOptions | null>(`new-server-scope:${permitted}`, async (signal) =>
    permitted ? api.getScopeOptions({ signal }) : null,
  )

  const [draft, setDraft] = useState<ServerDraft>(EMPTY_DRAFT)
  const [clientErrors, setClientErrors] = useState<ServerErrors>({})
  const [failure, setFailure] = useState<FormFailure | null>(null)
  const [busy, setBusy] = useState<'server' | 'agent' | null>(null)
  /** The server, once it exists. Until the agent exists too, the agent is tried again from here. */
  const [server, setServer] = useState<ServerDetail | null>(null)
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const summary = useRef<HTMLDivElement>(null)

  const backLink = { pathname: '/servers', search: view }

  if (!permitted) {
    return (
      <div className="rounded-sm border border-border bg-panel">
        <EmptyState
          title="Not permitted to add servers"
          hint="The console offers this only to an account that may change alert rules and holds the admin's permissions to add servers and to add and change agents, with access to every customer. The server checks it on every request."
        />
      </div>
    )
  }

  // A name another server has is the name field's problem; everything else general is said on top.
  const taken = failure?.code === 'server_exists' && failure.message ? [failure.message] : null
  const errors: ServerErrors = {
    ...clientErrors,
    ...(failure?.fields ?? {}),
    ...(taken ? { name: taken } : {}),
  }
  const lines = taken ? [] : summaryOf(failure)
  const invalid = Object.entries(errors).filter(([, messages]) => (messages?.length ?? 0) > 0)

  const edit = (changes: Partial<ServerDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    setClientErrors({})
    setFailure(null)
  }

  const failed = (error: unknown, what: string) => {
    setFailure(describeWriteFailure(error, SERVER_FIELDS))
    shell?.announce(what)
    requestAnimationFrame(() => summary.current?.focus())
  }

  const enrol = async (created: ServerDetail) => {
    setBusy('agent')
    setFailure(null)
    try {
      const result = await api.createAgent(created.item.server.id, {})
      setEnrollment(result)
      shell?.announce('Server and agent created. The agent token is shown once.')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'agent_exists') {
        // Made by an earlier try whose answer was lost: its token was never shown, and this page
        // cannot show it. The server's page says so and offers the rotation, which gives a new one.
        shell?.announce(
          'The agent exists already, but its token was not shown: rotate it from the server’s page.',
        )
        void navigate(viewTo(serverPath(created.item.server.id)), {
          replace: true,
          state: { agentTokenNotShown: true },
        })
        return
      }
      failed(error, 'The server was created, but its agent was not.')
    } finally {
      setBusy(null)
    }
  }

  const submit = async () => {
    const found = validate(draft)
    if (hasErrors(found)) {
      setClientErrors(found)
      shell?.announce('Some values are not valid.')
      requestAnimationFrame(() => summary.current?.focus())
      return
    }
    setBusy('server')
    setFailure(null)
    let created: ServerDetail
    try {
      created = await api.createServer(toInput(draft))
      setServer(created)
    } catch (error) {
      setBusy(null)
      failed(error, 'The server was not created.')
      return
    }
    await enrol(created)
  }

  const done = () => {
    if (!server) return
    setEnrollment(null)
    void navigate(viewTo(serverPath(server.item.server.id)), { replace: true })
  }

  const locked = busy !== null

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <Link
          to={backLink}
          className="type-data inline-flex w-fit items-center gap-1 rounded-sm text-fg-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          Servers
        </Link>
        <h1 className="type-title">Add server</h1>
      </header>

      {enrollment && server ? (
        <Panel title="Install the agent" features="servers" scope="NOW" className="max-w-4xl">
          <AgentEnrollment
            enrollment={enrollment}
            serverName={server.item.server.name}
            reason="created"
            onDone={done}
          />
        </Panel>
      ) : (
        <Panel
          title="New server"
          features="servers"
          scope="NOW"
          status={scope.data == null ? (scope.error ? 'error' : 'loading') : 'success'}
          error={scope.data == null ? scope.error : null}
          onRetry={scope.refetch}
          skeleton={<div className="h-64" />}
          className="max-w-4xl"
        >
          <form
            className="flex flex-col gap-4"
            noValidate
            aria-busy={locked}
            onSubmit={(event) => {
              event.preventDefault()
              if (!locked) void (server ? enrol(server) : submit())
            }}
          >
            <div ref={summary} tabIndex={-1} className="flex flex-col gap-2 outline-none">
              {server ? (
                <Notice
                  status="warning"
                  word="NO AGENT YET"
                  live="alert"
                  actions={
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={locked}
                      aria-busy={busy === 'agent'}
                    >
                      {busy === 'agent' ? 'Creating…' : 'Create the agent'}
                    </Button>
                  }
                >
                  <p className="type-body-strong">
                    The server “{server.item.server.name}” is created, but its agent is not.
                  </p>
                  {lines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <p>
                    Create the agent now, or later from{' '}
                    <Link
                      to={viewTo(serverPath(server.item.server.id))}
                      className="text-primary underline underline-offset-2"
                    >
                      the server’s page
                    </Link>
                    .
                  </p>
                </Notice>
              ) : invalid.length > 0 || lines.length > 0 ? (
                <Notice status="critical" word="NOT ADDED" live="alert">
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

            {server ? null : (
              <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
                <FieldInput
                  label="Name"
                  value={draft.name}
                  onChange={(name) => edit({ name })}
                  error={errors.name}
                  input={{
                    disabled: locked,
                    autoComplete: 'off',
                    spellCheck: false,
                    required: true,
                  }}
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
                  options={siteChoices(scope.data ?? { customers: [], sites: [] })}
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
            )}

            {server ? null : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={locked}
                  aria-busy={busy === 'server'}
                >
                  {busy === 'server'
                    ? 'Adding…'
                    : busy === 'agent'
                      ? 'Creating the agent…'
                      : 'Add server'}
                </Button>
                <span className="type-body text-fg-muted">
                  Its agent is created with it, and the token to install is shown once.
                </span>
              </div>
            )}
          </form>
        </Panel>
      )}
    </div>
  )
}
