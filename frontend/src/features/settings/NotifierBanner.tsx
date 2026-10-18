import type { NotifierStatus } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import {
  NOTIFIER_HEALTH,
  NOTIFIER_WORD,
  SMTP_ERROR_TEXT,
  agoText,
  notifierNeedsAttention,
  notifierSentence,
  reportedText,
} from '@/lib/settings'
import { STATUS_FRAME, STATUS_TINT, StatusTag } from '@/ui/status'

/**
 * The notifier's state, as it reported itself: running, failed, stale, never started or disabled.
 * Only running is drawn as healthy. A disabled notifier (this server sends no email) is drawn idle,
 * and a state that is not running says what it means for queued email. The mail server's settings
 * are what the notifier itself reported (the web process holds no password and shows none).
 */
export function NotifierBanner({
  status,
  generatedAt,
  className,
}: {
  status: NotifierStatus
  generatedAt: string
  className?: string
}) {
  const { tz } = usePrefs()
  const nowMs = Date.parse(generatedAt)
  const ago = (iso: string | null) => agoText(iso, nowMs, 'never')
  const attention = notifierNeedsAttention(status.state)
  const health = NOTIFIER_HEALTH[status.state]
  const facts =
    status.state === 'disabled' || status.state === 'never_started'
      ? []
      : [
          `last success ${ago(status.lastSuccessAt)}`,
          `last attempt ${ago(status.lastAttemptAt)}`,
          `last sign of life ${ago(status.lastActiveAt)}`,
          status.lastCycleMs === null ? null : `cycle ${status.lastCycleMs} ms`,
          status.intervalSeconds === null ? null : `every ${status.intervalSeconds} s`,
        ].filter((part): part is string => part !== null)
  return (
    <section
      aria-label="Notifier"
      data-state={status.state}
      className={cn(
        'type-body flex flex-col gap-1 rounded-sm border px-3 py-2',
        attention && (health === 'critical' || health === 'warning')
          ? cn(STATUS_FRAME[health], STATUS_TINT[health])
          : attention
            ? 'border-border-strong bg-panel'
            : 'border-border bg-panel',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="type-label text-fg-muted">NOTIFIER</span>
        <StatusTag status={health} word={NOTIFIER_WORD[status.state]} />
        <span className="min-w-0 flex-1">{notifierSentence(status, nowMs)}</span>
      </div>
      {facts.length > 0 ? <p className="type-data text-fg-muted">{facts.join(' · ')}</p> : null}
      {status.state !== 'disabled' ? (
        <p className="type-data text-fg-muted">
          mail server {reportedText(status.smtpConfigured, 'set', 'not set')} · login{' '}
          {reportedText(status.authenticationConfigured, 'configured', 'not configured')} · last
          reached {ago(status.lastSmtpSuccessAt)}
          <span className="text-fg-faint"> (as the notifier reported)</span>
        </p>
      ) : null}
      {status.lastSmtpError ? (
        <p className="text-fg-muted">
          Last mail server failure{' '}
          <time dateTime={status.lastSmtpError.at}>
            {formatClock(Date.parse(status.lastSmtpError.at), tz)}
          </time>
          : {SMTP_ERROR_TEXT[status.lastSmtpError.category]}.
        </p>
      ) : null}
    </section>
  )
}
