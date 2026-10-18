import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import type { HealthStatus } from '@/api/types'
import { STATUS_FRAME, STATUS_TINT, StatusTag } from '@/ui/status'

interface NoticeProps {
  /** The state it is drawn in: the mark and the word agree with the color. */
  status: HealthStatus
  /** A word for the mark: "SAVED", "NOT SAVED", "UNAVAILABLE". */
  word: string
  /** `alert` for what went wrong now, `status` for what happened, none for what is simply so. */
  live?: 'alert' | 'status'
  /** Actions on the right: a retry, a dismiss. */
  actions?: ReactNode
  className?: string
  children: ReactNode
}

/**
 * An inline message above or inside a form: a mark and a word, the sentence, and what to do about
 * it. Never color alone, and never a toast: it stays until the situation changes or it is dismissed.
 */
export function Notice({ status, word, live, actions, className, children }: NoticeProps) {
  const Tag = live === 'status' ? 'output' : 'div'
  return (
    <Tag
      role={live === 'alert' ? 'alert' : undefined}
      className={cn(
        'type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-3 py-2',
        status === 'healthy' || status === 'warning' || status === 'critical'
          ? cn(STATUS_FRAME[status], STATUS_TINT[status])
          : 'border-border bg-raised',
        className,
      )}
    >
      <StatusTag status={status} word={word} />
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </Tag>
  )
}
