import { useEffect, useId, useRef } from 'react'
import type { AgentEnrollment as Enrollment } from '@/api/types'
import { CopyButton } from '@/ui/CopyButton'
import { Button } from '@/ui/controls'
import { Notice } from '@/ui/states'
import {
  AGENT_ENV_FILE,
  RELEASE_PLACEHOLDER,
  installCommands,
  rotationCommands,
} from './enrollment'

interface AgentEnrollmentProps {
  enrollment: Enrollment
  serverName: string
  /** Why the token is new: made with the agent, or rotated. */
  reason: 'created' | 'rotated'
  /** The operator has copied what they need: whoever renders this forgets the token. */
  onDone: () => void
}

/**
 * The one view that shows an agent's token: once, with the server's address and the commands for
 * the host, the token kept off every command line. A new agent gets the installation; a rotated
 * token gets the commands that replace the token line of the host's environment file and restart
 * the agent, nothing more. Without the server's address (no `SENTINEL_URL`) the installation is
 * not shown with a guessed one: the view says to set it. It holds the token in its props only:
 * closing it (Done, or leaving the page) is the end of it. Nothing here writes to the URL, the
 * history, any storage or any cache.
 */
export function AgentEnrollment({ enrollment, serverName, reason, onDone }: AgentEnrollmentProps) {
  const headingId = useId()
  const notice = useRef<HTMLDivElement>(null)
  // The button that led here is gone: the notice takes the focus, so what happened is read next.
  useEffect(() => notice.current?.focus(), [])
  const rotated = reason === 'rotated'
  const script = rotated
    ? rotationCommands()
    : enrollment.serverUrl === null
      ? null
      : installCommands(enrollment.serverUrl)
  return (
    <div className="flex flex-col gap-3">
      <div ref={notice} tabIndex={-1} className="outline-none">
        <Notice status="warning" word="SHOWN ONCE" live="status">
          <p className="type-body-strong">
            {rotated
              ? `“${serverName}” has a new token, shown once.`
              : `The agent of “${serverName}” is created. Its token is shown once.`}
          </p>
          <p>
            Copy it now and put it on the host: the console cannot show it again.{' '}
            {rotated
              ? 'The previous token stopped working at once; the host fails until it has this one and its agent is restarted.'
              : 'If it is lost, rotate the token for a new one.'}
          </p>
        </Notice>
      </div>

      <dl className="grid gap-3 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-faint">Agent token</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code
              aria-label="Agent token"
              className="type-data min-w-0 rounded-sm border border-border bg-raised px-2 py-1 break-all select-all"
            >
              {enrollment.token}
            </code>
            <CopyButton text={enrollment.token} label="Copy token" what="Token" />
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="type-label text-fg-faint">Server URL for the agent</dt>
          {enrollment.serverUrl === null ? (
            <dd className="type-body text-fg-muted">
              Not known: set SENTINEL_URL on the server (the https:// address of this console).
            </dd>
          ) : (
            <dd className="flex flex-wrap items-center gap-2">
              <code
                aria-label="Server URL"
                className="type-data min-w-0 rounded-sm border border-border bg-raised px-2 py-1 break-all select-all"
              >
                {enrollment.serverUrl}
              </code>
              <CopyButton text={enrollment.serverUrl} label="Copy URL" what="URL" />
            </dd>
          )}
        </div>
      </dl>

      <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={headingId} className="type-label text-fg-muted">
            {rotated
              ? 'Put the new token on the host (systemd)'
              : 'Install on a Linux host (systemd)'}
          </h3>
          {script === null ? null : (
            <CopyButton text={script} label="Copy commands" what="Commands" />
          )}
        </div>
        {rotated ? (
          <p className="type-body text-fg-faint">
            Run in bash on the host that has the agent. The commands ask for the token and type it
            hidden into the root-only <code className="type-data">{AGENT_ENV_FILE}</code>, replacing
            only its token line, then restart the agent: it is never on a command line. The full
            guide is docs/agent-deployment.md (Token rotation).
          </p>
        ) : script === null ? (
          <Notice status="warning" word="NO ADDRESS">
            <p>
              The server has no address to give the agent, so no commands are shown: set
              SENTINEL_URL on the server (the https:// address of this console), then install the
              agent with docs/agent-deployment.md and this token.
            </p>
          </Notice>
        ) : (
          <p className="type-body text-fg-faint">
            Run in bash on the host, one step at a time, replacing{' '}
            <code className="type-data">{RELEASE_PLACEHOLDER}</code> with the release you deploy.
            Step 3 asks for the token and types it hidden into the root-only{' '}
            <code className="type-data">{AGENT_ENV_FILE}</code>: it is never on a command line. The
            full guide is docs/agent-deployment.md.
          </p>
        )}
        {script === null ? null : (
          <pre
            aria-label={rotated ? 'Rotation commands' : 'Installation commands'}
            className="type-data max-h-96 overflow-auto rounded-sm border border-border bg-raised p-3 whitespace-pre"
          >
            <code>{script}</code>
          </pre>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
        <span className="type-body text-fg-muted">Closing this forgets the token.</span>
      </div>
    </div>
  )
}
