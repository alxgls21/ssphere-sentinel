import { useContext, useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { useApi } from '@/api/context'
import type { AgentEnrollment as Enrollment, ServerDetail } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { usePrefs } from '@/app/prefs'
import { ShellContext } from '@/app/shell'
import type { Resource } from '@/hooks/useResource'
import { describeWriteFailure, summaryOf } from '@/lib/forms'
import { EMPTY, formatAgo, formatClock } from '@/lib/format'
import { Fact } from '@/ui/Fact'
import { Panel } from '@/ui/Panel'
import { Button } from '@/ui/controls'
import { Notice } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { AgentEnrollment } from './AgentEnrollment'
import { AGENT_ENV_FILE } from './enrollment'

interface AgentPanelProps {
  index: number
  serverId: string
  serverName: string
  resource: Resource<ServerDetail>
  className?: string
}

type Pending = 'create' | 'rotate' | 'toggle'

/**
 * The warning before a rotation: the current token ends at once. Nothing happens until it is
 * confirmed; the safe button (cancel) takes the focus first, and Escape cancels.
 */
function RotateConfirm({
  serverName,
  busy,
  onConfirm,
  onCancel,
}: {
  serverName: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels, from wherever the focus is inside
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <Notice
        status="warning"
        word="ENDS THE TOKEN"
        actions={
          <>
            <Button ref={cancel} onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
              {busy ? 'Rotating…' : 'Rotate token'}
            </Button>
          </>
        }
      >
        <p id={titleId} className="type-body-strong">
          Give the agent of “{serverName}” a new token?
        </p>
        <p>
          The current token stops working at once: the host fails until{' '}
          <code className="type-data">{AGENT_ENV_FILE}</code> holds the new one, which is shown
          once.
        </p>
      </Notice>
    </div>
  )
}

/**
 * [n] Agent: who reports for this server, and, for an account that may manage hosts, the
 * actions on it: create the agent of a server that has none, rotate its token (shown once, here)
 * and disable or enable it. Every answer is the server's; the token is kept in this panel's
 * state only until Done. Add server sends the operator here when the agent existed already (an
 * earlier try whose answer was lost): the panel then says no token was shown, until one is rotated.
 */
export function AgentPanel({ index, serverId, serverName, resource, className }: AgentPanelProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const location = useLocation()
  const { capabilities } = useAuth()
  const { tz } = usePrefs()
  const agent = resource.data?.agent ?? null
  const nowMs = resource.data ? Date.parse(resource.data.generatedAt) : 0
  const may = capabilities.manageServers

  const [shown, setShown] = useState<{
    enrollment: Enrollment
    reason: 'created' | 'rotated'
  } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<Pending | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [tokenNotShown, setTokenNotShown] = useState(
    () => (location.state as { agentTokenNotShown?: unknown } | null)?.agentTokenNotShown === true,
  )

  const run = async (what: Pending, action: () => Promise<void>) => {
    setBusy(what)
    setProblem(null)
    try {
      await action()
    } catch (error) {
      const failure = describeWriteFailure(error, [])
      setProblem(summaryOf(failure).join(' ') || 'The change could not be made.')
      shell?.announce('The agent was not changed.')
    } finally {
      setBusy(null)
    }
  }

  const create = () =>
    run('create', async () => {
      setShown({ enrollment: await api.createAgent(serverId, {}), reason: 'created' })
      shell?.announce('Agent created. Its token is shown once.')
    })
  const rotate = () =>
    run('rotate', async () => {
      if (!agent) return
      setShown({ enrollment: await api.rotateAgentToken(agent.id), reason: 'rotated' })
      setConfirm(false)
      setTokenNotShown(false)
      shell?.announce('Token rotated. The new token is shown once.')
    })
  const toggle = () =>
    run('toggle', async () => {
      if (!agent) return
      const change = await api.setAgentEnabled(agent.id, !agent.enabled)
      shell?.announce(change.item.enabled ? 'Agent enabled.' : 'Agent disabled.')
      resource.refetch()
    })
  const done = () => {
    setShown(null)
    resource.refetch()
  }

  return (
    <Panel
      index={index}
      title="Agent"
      features="servers"
      scope="NOW"
      className={className}
      status={resource.status}
      error={resource.error}
      updatedAt={resource.updatedAt}
      onRetry={resource.refetch}
      skeleton={<div className="h-16" />}
    >
      {shown ? (
        <AgentEnrollment
          enrollment={shown.enrollment}
          serverName={serverName}
          reason={shown.reason}
          onDone={done}
        />
      ) : resource.data ? (
        <div className="flex flex-col gap-3">
          {problem ? (
            <Notice status="critical" word="NOT DONE" live="alert">
              {problem}
            </Notice>
          ) : null}
          {tokenNotShown && agent ? (
            <Notice status="warning" word="TOKEN NOT SHOWN" live="status">
              <p className="type-body-strong">
                This server had an agent already, so none was created and no token was shown.
              </p>
              <p>
                If the host does not hold its token, rotate it: the new one is shown once, here.
              </p>
            </Notice>
          ) : null}
          {agent ? (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
                <Fact label="Name">{agent.name}</Fact>
                <Fact label="State">
                  <StatusTag
                    status={agent.enabled ? 'healthy' : 'idle'}
                    word={agent.enabled ? 'ENABLED' : 'DISABLED'}
                    variant="tag"
                  />
                </Fact>
                <Fact label="Last heartbeat">
                  {agent.lastSeenAt ? (
                    <span title={formatClock(Date.parse(agent.lastSeenAt), tz)}>
                      {formatAgo(agent.lastSeenAt, nowMs)}
                    </span>
                  ) : (
                    'never'
                  )}
                </Fact>
                <Fact label="Version">{agent.agentVersion ? `v${agent.agentVersion}` : EMPTY}</Fact>
              </dl>
              {!agent.enabled ? (
                <p className="type-body text-fg-muted">
                  Disabled: its heartbeats are refused, and the host reads as offline once the
                  window passes. Enabling it again needs no new token.
                </p>
              ) : null}
              {confirm ? (
                <RotateConfirm
                  serverName={serverName}
                  busy={busy === 'rotate'}
                  onConfirm={() => void rotate()}
                  onCancel={() => setConfirm(false)}
                />
              ) : null}
              {may && !confirm ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => setConfirm(true)} disabled={busy !== null}>
                    Rotate token
                  </Button>
                  <Button
                    onClick={() => void toggle()}
                    disabled={busy !== null}
                    aria-busy={busy === 'toggle'}
                  >
                    {agent.enabled ? 'Disable agent' : 'Enable agent'}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="type-body text-fg-muted">
                This server has no agent yet: nothing reports for it until one is created and
                installed on the host.
              </p>
              {may ? (
                <Button
                  variant="primary"
                  onClick={() => void create()}
                  disabled={busy !== null}
                  aria-busy={busy === 'create'}
                >
                  {busy === 'create' ? 'Creating…' : 'Create agent'}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </Panel>
  )
}
