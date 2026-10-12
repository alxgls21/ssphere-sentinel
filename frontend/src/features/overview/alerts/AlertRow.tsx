import type { Alert } from '@/api/types'
import { formatAge } from '@/lib/format'
import { StatusTag } from '@/ui/status'

/**
 * One sample alert: severity, rule summary, entity, age. Rows are not links:
 * there is no alert screen to open, and nothing here may look operational.
 */
export function AlertRow({ alert, now }: { alert: Alert; now: number }) {
  return (
    <li className="flex min-h-(--row-h) items-center gap-2 px-3">
      <StatusTag status={alert.severity} />
      <span className="type-body min-w-0 flex-1 truncate">{alert.title}</span>
      <span className="type-data max-w-[45%] truncate">{alert.subject.name}</span>
      <span className="type-data w-8 shrink-0 text-right text-fg-faint">
        {formatAge(alert.since, now)}
      </span>
    </li>
  )
}
