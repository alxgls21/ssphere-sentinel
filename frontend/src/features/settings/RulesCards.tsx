import { Link, useLocation } from 'react-router'
import type { AlertRule } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { KIND_SHORT } from '@/lib/incidents'
import { Button } from '@/ui/controls'
import { SeverityTag } from '@/ui/incidents'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { conditionOf, scopeText, timingOf } from './rulesModel'
import { rulePath } from './sections'

interface RulesCardsProps {
  rows: readonly AlertRule[]
  mayEdit: boolean
  busy: string | null
  onToggle: (rule: AlertRule) => void
}

/**
 * The same list for a phone: one card per rule, still a list of links. The enable button sits
 * outside the link (a button never lives inside one) and only where the account may change the rule.
 */
export function RulesCards({ rows, mayEdit, busy, onToggle }: RulesCardsProps) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Alert rules" className="min-h-0 flex-1 overflow-auto">
      {rows.map((rule) => (
        <li key={rule.id} className="relative border-b border-border last:border-b-0">
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 left-0 w-0.5',
              rule.enabled ? STATUS_EDGE[rule.severity] : STATUS_EDGE.idle,
            )}
          />
          <Link
            to={viewTo(rulePath(rule.id))}
            state={{ list: location.search }}
            className="flex flex-col gap-1.5 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
          >
            <span className="flex flex-wrap items-center gap-2">
              <StatusTag
                status={rule.enabled ? 'healthy' : 'idle'}
                word={rule.enabled ? 'ENABLED' : 'DISABLED'}
                variant="tag"
              />
              <SeverityTag severity={rule.severity} />
              <span className="type-data ml-auto text-fg-faint">{rule.openIncidents} open</span>
            </span>
            <span className="type-data-strong min-w-0 truncate">{rule.name}</span>
            <span className="type-data text-fg-faint">
              {KIND_SHORT[rule.kind]} {rule.kind} · {scopeText(rule.scope)}
            </span>
            <span className="type-body text-fg-muted">{conditionOf(rule)}</span>
            <span className="type-data text-fg-faint">delays {timingOf(rule)}</span>
          </Link>
          {mayEdit && rule.canEdit ? (
            <div className="pr-3 pb-2.5 pl-4">
              <Button
                size="sm"
                aria-label={`${rule.enabled ? 'Disable' : 'Enable'} rule ${rule.name}`}
                disabled={busy === rule.id}
                onClick={() => onToggle(rule)}
              >
                {rule.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
