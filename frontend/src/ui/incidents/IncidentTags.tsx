import { Archive, BellRing, CircleCheck, EyeOff, type LucideIcon } from 'lucide-react'
import type { AlertSeverity, IncidentStatus } from '@/api/types'
import { cn } from '@/lib/cn'
import { SEVERITY_WORD, STATUS_SENTENCE, STATUS_WORD } from '@/lib/incidents'
import { STATUS_TEXT, STATUS_TINT, StatusTag } from '@/ui/status'

/** The severity an incident opened at, in the status alphabet: shape, word and color together. */
export function SeverityTag({
  severity,
  className,
}: {
  severity: AlertSeverity
  className?: string
}) {
  return (
    <StatusTag
      status={severity}
      word={SEVERITY_WORD[severity]}
      variant="tag"
      className={className}
    />
  )
}

const ICON: Record<IncidentStatus, LucideIcon> = {
  active: BellRing,
  acknowledged: EyeOff,
  recovered: CircleCheck,
  closed: Archive,
}

/**
 * Active, acknowledged, recovered and closed stay apart by word and mark, never by color alone:
 * active is the loud one, acknowledged is outlined (it is seen, and still open), recovered is the
 * one healthy mark, closed is dashed and quiet (it ended without a recovery).
 */
const LOOK: Record<IncidentStatus, string> = {
  active: 'bg-hover text-fg',
  acknowledged: 'border border-border-strong text-fg',
  recovered: cn(STATUS_TEXT.healthy, STATUS_TINT.healthy),
  closed: 'border border-dashed border-border-strong text-fg-muted',
}

export function IncidentStatusTag({
  status,
  className,
}: {
  status: IncidentStatus
  className?: string
}) {
  const Icon = ICON[status]
  return (
    <span
      data-incident-status={status}
      title={STATUS_SENTENCE[status]}
      className={cn(
        'type-tag inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 whitespace-nowrap',
        LOOK[status],
        className,
      )}
    >
      <Icon size={12} strokeWidth={1.5} aria-hidden="true" />
      <span>{STATUS_WORD[status]}</span>
      {status === 'acknowledged' ? <span className="sr-only">, still open</span> : null}
    </span>
  )
}
