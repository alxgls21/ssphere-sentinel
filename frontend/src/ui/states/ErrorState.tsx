import { Button } from '@/ui/controls/Button'
import { StatusTag } from '@/ui/status'

interface ErrorStateProps {
  title: string
  message?: string
  /** "Showing data from 14:03:10Z" when earlier data is still visible. */
  lastGood?: string
  onRetry?: () => void
  /** Inline banner above kept data (non-blocking) instead of a centered block. */
  banner?: boolean
}

/** Inline, recoverable error. role=alert so it is announced once; Retry is always offered. */
export function ErrorState({ title, message, lastGood, onRetry, banner = false }: ErrorStateProps) {
  if (banner) {
    return (
      <output className="type-data flex items-center gap-2 border-b border-border bg-raised px-3 py-1.5">
        <StatusTag status="critical" word="ERROR" />
        <span className="min-w-0 flex-1 truncate text-fg-muted">
          {title}
          {lastGood ? <span className="text-fg-faint"> · {lastGood}</span> : null}
        </span>
        {onRetry ? (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </output>
    )
  }
  return (
    <div
      role="alert"
      className="flex h-full min-h-24 flex-col items-start justify-center gap-2 p-3"
    >
      <p className="type-title text-fg">{title}</p>
      {message ? <p className="type-body max-w-prose text-fg-muted">{message}</p> : null}
      {lastGood ? <p className="type-data text-fg-faint">{lastGood}</p> : null}
      {onRetry ? (
        <Button onClick={onRetry} aria-keyshortcuts="r">
          Retry
        </Button>
      ) : null}
    </div>
  )
}
