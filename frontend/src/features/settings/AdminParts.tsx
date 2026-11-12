import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, type To } from 'react-router'
import { formatAge, formatStamp, withAgo, type Timezone } from '@/lib/format'
import { Button, Tooltip } from '@/ui/controls'
import { EmptyState, Notice } from '@/ui/states'

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A time shown as an age carries its exact time in a tooltip. It takes a tab stop so a keyboard user
   can open it, and names the same text for a screen reader. */

/** What the administration pages share: the refusal, the back link, the table classes, a flash. */

export const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
export const CELL = 'border-b border-border whitespace-nowrap'
export const ROW =
  'relative h-(--row-h) cursor-pointer transition-colors duration-(--dur-fast) hover:bg-hover'
export const NAME_LINK =
  'type-data-strong flex min-w-0 items-baseline gap-1.5 rounded-sm -outline-offset-2 hover:underline'

/** How long a search must hold still before it is asked for. */
export const SEARCH_SETTLE_MS = 250

/** The page says why it offers nothing: the capability is the server's to grant, and it checks every request. */
export function NotPermitted({ what, hint }: { what: string; hint: string }) {
  return (
    <div className="rounded-sm border border-border bg-panel">
      <EmptyState title={`Not permitted to ${what}`} hint={hint} />
    </div>
  )
}

export function BackLink({ to, children }: { to: To; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="type-data inline-flex w-fit items-center gap-1 rounded-sm text-fg-muted hover:text-fg"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      {children}
    </Link>
  )
}

/** An age with its exact time in a tooltip. */
export function AgeCell({
  iso,
  nowMs,
  tz,
  what,
}: {
  iso: string
  nowMs: number
  tz: Timezone
  what: string
}) {
  return (
    <Tooltip content={`${what} ${formatStamp(Date.parse(iso), tz, nowMs)}`}>
      <span tabIndex={0} aria-label={`${what} ${withAgo(formatAge(iso, nowMs))}`}>
        {formatAge(iso, nowMs)}
      </span>
    </Tooltip>
  )
}

export interface Flash {
  tone: 'ok' | 'error'
  text: string
}

/** What was just done, or what was refused, until dismissed. */
export function FlashNotice({ flash, onDismiss }: { flash: Flash | null; onDismiss: () => void }) {
  if (!flash) return null
  return (
    <Notice
      status={flash.tone === 'ok' ? 'healthy' : 'critical'}
      word={flash.tone === 'ok' ? 'DONE' : 'NOT DONE'}
      live={flash.tone === 'ok' ? 'status' : 'alert'}
      actions={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      {flash.text}
    </Notice>
  )
}
