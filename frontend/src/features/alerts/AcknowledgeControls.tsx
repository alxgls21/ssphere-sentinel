import type { AckNotice } from './acknowledge'
import { Button } from '@/ui/controls'
import { STATUS_TEXT } from '@/ui/status'

/** Shown only for an incident the API says this user may acknowledge now. */
export function AcknowledgeButton({
  label,
  busy,
  onAcknowledge,
}: {
  /** The object's name: the button's accessible name says which incident it acts on. */
  label: string
  busy: boolean
  onAcknowledge: () => void
}) {
  return (
    <Button
      size="sm"
      aria-label={`Acknowledge incident on ${label}`}
      aria-busy={busy}
      disabled={busy}
      onClick={onAcknowledge}
    >
      {busy ? 'Acknowledging…' : 'Acknowledge'}
    </Button>
  )
}

/** The outcome of the last attempt, spoken politely, and an error loudly. */
export function AckNoticeLine({
  notice,
  onDismiss,
}: {
  notice: AckNotice | null
  onDismiss?: () => void
}) {
  if (!notice) return null
  const error = notice.tone === 'error'
  return (
    <div
      role={error ? 'alert' : 'status'}
      className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-border bg-raised px-3 py-2"
    >
      <span className={error ? `type-tag ${STATUS_TEXT.critical}` : 'type-tag text-fg-muted'}>
        {error ? 'NOT ACKNOWLEDGED' : 'ACKNOWLEDGED'}
      </span>
      <span className="min-w-0 flex-1">{notice.text}</span>
      {onDismiss ? (
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      ) : null}
    </div>
  )
}
