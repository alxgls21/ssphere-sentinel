import { usePrefs } from '@/app/prefs'
import { formatTime } from '@/lib/format'
import { Tooltip } from '@/ui/controls'
import { useNow } from '../useNow'

/**
 * HH:mm:ss in the preferred timezone ("Z" marks UTC); a click, like key z,
 * switches between UTC and local. The ticking digits are hidden from assistive
 * technology, which gets the time to the minute (updated once a minute).
 */
export function UtcClock() {
  const { tz, toggleTz } = usePrefs()
  const now = useNow()
  const zone = tz === 'utc' ? 'UTC' : 'local time'
  const other = tz === 'utc' ? 'local time' : 'UTC'
  const minute = Math.floor(now / 60_000) * 60_000
  return (
    <Tooltip content={`Showing ${zone}. Click or press z to show ${other}.`}>
      <button
        type="button"
        onClick={toggleTz}
        className="type-data h-(--ctl-h) shrink-0 rounded-sm px-2 text-fg-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg"
      >
        <span aria-hidden="true" className="tnum">
          {formatTime(now, tz)}
          {tz === 'utc' ? 'Z' : ''}
        </span>
        <span className="sr-only">
          {formatTime(minute, tz, false)} {zone}, switch to {other}
        </span>
      </button>
    </Tooltip>
  )
}
