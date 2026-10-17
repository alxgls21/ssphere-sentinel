import { BellRing } from 'lucide-react'
import { Link } from 'react-router'
import { useAlerts } from '@/app/alerts'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { ENGINE_HEALTH, ENGINE_WORD } from '@/lib/incidents'
import { Tooltip } from '@/ui/controls'
import { buttonStyle } from '@/ui/controls/buttonStyle'
import { STATUS_TEXT, STATUS_TINT, StatusGlyph } from '@/ui/status'

/** The badge shows at most this many; the exact number is in the name and the Alerts screen. */
const BADGE_MAX = 99

/**
 * The notification indicator: how many incidents are open in the topbar scope, as the API counts
 * them over all of it (never the ones a page happened to load), and the way to the Alerts screen.
 * An acknowledged incident is still open, so it still counts. An engine that is not running is
 * marked beside the number and named in it: zero open incidents from an engine that never ran is
 * not good news. No count is shown while there is none to trust. Nothing here is a push: it is read
 * when the page polls, like every other figure.
 */
export function IncidentBell() {
  const alerts = useAlerts()
  const viewTo = useViewTo()
  if (!alerts) return null
  const { overview, engine } = alerts

  const data = overview.data
  const engineState = engine.data?.state
  const engineProblem =
    engineState !== undefined ? engineState !== 'running' : engine.status === 'error'
  const engineWord =
    engineState !== undefined
      ? `alert engine ${ENGINE_WORD[engineState].toLowerCase()}`
      : engine.status === 'error'
        ? 'alert engine state unavailable'
        : null

  const open = data?.open
  const critical = data?.critical ?? 0
  const count =
    open === undefined
      ? overview.status === 'error'
        ? '?'
        : null
      : open > BADGE_MAX
        ? `${BADGE_MAX}+`
        : String(open)
  const stale = data !== undefined && overview.error !== null
  const summary =
    open === undefined
      ? overview.status === 'error'
        ? 'open incidents unavailable'
        : 'loading open incidents'
      : `${open} open ${open === 1 ? 'incident' : 'incidents'}${critical > 0 ? `, ${critical} critical` : ''}${stale ? ', last read may be out of date' : ''}`
  const label = `Alerts: ${summary}${engineProblem && engineWord ? `; ${engineWord}` : ''}`

  const tone =
    open === undefined
      ? cn(STATUS_TEXT.unknown, STATUS_TINT.unknown)
      : critical > 0
        ? cn(STATUS_TEXT.critical, STATUS_TINT.critical)
        : open > 0
          ? cn(STATUS_TEXT.warning, STATUS_TINT.warning)
          : 'text-fg-muted'

  return (
    <Tooltip content={label}>
      <Link
        to={viewTo('/alerts')}
        aria-label={label}
        data-open={open}
        className={cn(buttonStyle('ghost'), 'shrink-0 gap-1.5 px-2')}
      >
        <BellRing size={16} strokeWidth={1.5} aria-hidden="true" />
        {count !== null ? (
          <span aria-hidden="true" className={cn('type-tag tnum rounded-sm px-1.5', tone)}>
            {count}
          </span>
        ) : null}
        {engineProblem ? (
          <StatusGlyph status={engineState ? ENGINE_HEALTH[engineState] : 'unknown'} size={10} />
        ) : null}
      </Link>
    </Tooltip>
  )
}
