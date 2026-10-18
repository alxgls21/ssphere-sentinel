import { useState } from 'react'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { NotificationSettings } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { EMPTY, formatClock } from '@/lib/format'
import {
  TEST_EMAIL_HEALTH,
  TEST_EMAIL_WORD,
  isTestEmailOpen,
  testEmailSentence,
  waitingNote,
} from '@/lib/settings'
import { Panel } from '@/ui/Panel'
import { Button } from '@/ui/controls'
import { Notice } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { useCountdown } from './useCountdown'
import { useTestEmail } from './useTestEmail'

interface TestEmailPanelProps {
  settings: NotificationSettings
  /** This account may send test emails, by its session. The server's own answer is also needed. */
  permitted: boolean
  /** Read the settings again (what a refusal says may have changed). */
  onRefresh: () => void
  className?: string
}

/** What the server's refusals of a test email say, by code. */
function refusal(error: unknown): { text: string; wait: number | null; refresh: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      const wait = error.retryAfterSeconds ?? 60
      return {
        text: `One test email a minute: try again in ${wait} s.`,
        wait,
        refresh: false,
      }
    }
    if (error.code === 'email_disabled') {
      return {
        text: 'This server sends no email: no mail server is set.',
        wait: null,
        refresh: true,
      }
    }
    if (error.code === 'no_email_address') {
      return {
        text: 'Your account has no email address. Ask an administrator to add one.',
        wait: null,
        refresh: true,
      }
    }
    if (error.code === 'test_email_pending') {
      return {
        text: 'A test email you asked for is still waiting to be sent.',
        wait: null,
        refresh: true,
      }
    }
    if (error.status === 403) {
      return { text: 'You may not send test emails.', wait: null, refresh: true }
    }
    if (error.code === 'network' || error.code === 'timeout') {
      return {
        text: 'The server could not be reached, so it is not known whether a test email was queued. Reload to check.',
        wait: null,
        refresh: false,
      }
    }
    return {
      text: `The test email could not be requested: ${error.message}`,
      wait: null,
      refresh: false,
    }
  }
  return { text: 'The test email could not be requested.', wait: null, refresh: false }
}

/**
 * A test email, to the account's own address: asked for here, sent by the notifier. The panel
 * follows it (queued, sending, and then sent, failed, cancelled or expired) and asks again only
 * while it is not final. It offers the action only to an account that may use it, and says why it is
 * unavailable when it is: no mail server here, no address, one still waiting, or the minute that must pass.
 */
export function TestEmailPanel({ settings, permitted, onRefresh, className }: TestEmailPanelProps) {
  const api = useApi()
  const { tz } = usePrefs()
  const { latest, asOf, notifier, trouble, accept } = useTestEmail(
    settings.testEmail.latest,
    settings.generatedAt,
  )
  const [requesting, setRequesting] = useState(false)
  // A rate limit's notice names a wait: it goes when the wait is over, rather than say it still applies.
  const [notice, setNotice] = useState<{ text: string; limited: boolean } | null>(null)
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  const left = useCountdown(waitUntil)

  const shownNotice = notice && (!notice.limited || left > 0) ? notice : null
  const allowed = permitted && settings.testEmail.allowed
  const open = latest !== null && isTestEmailOpen(latest.status)
  const nowMs = Date.parse(asOf)
  const blocked = !settings.email.available
    ? 'This server sends no email, so there is nothing to test.'
    : settings.account.email === null
      ? 'Your account has no email address to send it to.'
      : null

  const send = async () => {
    setRequesting(true)
    setNotice(null)
    try {
      accept(await api.requestTestEmail())
    } catch (error) {
      const found = refusal(error)
      setNotice({ text: found.text, limited: found.wait !== null })
      if (found.wait !== null) setWaitUntil(Date.now() + found.wait * 1000)
      if (found.refresh) onRefresh()
    } finally {
      setRequesting(false)
    }
  }

  return (
    <Panel
      title="Test email"
      features="settings"
      scope="NOW"
      className={className}
      footer={
        <span className="truncate">
          Sent once, to your account’s address, by the notifier. Never to another address.
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {allowed ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void send()}
              disabled={requesting || open || blocked !== null || left > 0}
              aria-busy={requesting}
            >
              {requesting ? 'Asking…' : 'Send test email'}
            </Button>
            {left > 0 ? (
              <span className="type-data tnum text-fg-muted" aria-hidden="true">
                try again in {left} s
              </span>
            ) : null}
            {blocked ? <span className="type-body text-fg-muted">{blocked}</span> : null}
            {open && !blocked ? (
              <span className="type-body text-fg-muted">
                One is on its way: you can ask for another when it is final.
              </span>
            ) : null}
          </div>
        ) : (
          <p className="type-body text-fg-muted">
            This account may not send test emails: it lacks the permission for it.
          </p>
        )}

        {shownNotice ? (
          <Notice
            status="warning"
            word="NOT QUEUED"
            live="alert"
            actions={
              <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            }
          >
            {shownNotice.text}
          </Notice>
        ) : null}

        {latest ? (
          <section aria-label="Latest test email" className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusTag
                status={TEST_EMAIL_HEALTH[latest.status]}
                word={TEST_EMAIL_WORD[latest.status]}
                variant="tag"
              />
              <span className="type-body min-w-0 flex-1">{testEmailSentence(latest, nowMs)}</span>
            </div>
            <p className="type-data text-fg-muted">
              asked{' '}
              <time dateTime={latest.createdAt}>
                {formatClock(Date.parse(latest.createdAt), tz)}
              </time>
              {isTestEmailOpen(latest.status) ? (
                <>
                  {' · '}expires{' '}
                  <time dateTime={latest.expiresAt}>
                    {formatClock(Date.parse(latest.expiresAt), tz)}
                  </time>
                </>
              ) : latest.finishedAt ? (
                <>
                  {' · '}finished{' '}
                  <time dateTime={latest.finishedAt}>
                    {formatClock(Date.parse(latest.finishedAt), tz)}
                  </time>
                </>
              ) : (
                EMPTY
              )}
              {latest.failure ? (
                <>
                  {' '}
                  {' · '}reason: {latest.failure.category}
                </>
              ) : null}
            </p>
            {open && waitingNote(notifier) ? (
              <p className="type-body text-fg-muted">{waitingNote(notifier)}</p>
            ) : null}
            {trouble === 'unreadable' ? (
              <output className="type-body block text-fg-muted">
                Its status could not be read just now: asking again.
              </output>
            ) : null}
            {trouble === 'gone' ? (
              <output className="type-body block text-fg-muted">
                It can no longer be found: reload to see where things stand.
              </output>
            ) : null}
          </section>
        ) : (
          <p className="type-body text-fg-muted">No test email has been asked for yet.</p>
        )}
      </div>
    </Panel>
  )
}
