import { useLocation, useNavigate } from 'react-router'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { useRange } from '@/app/viewState'
import { NEXT_PROBLEM_EVENT, type NextProblemDetail } from '@/config/events'
import { NAV_ITEMS, navItemForPath } from '@/config/nav'
import type { ShortcutAction } from '@/config/shortcuts'
import { stepRange } from '@/lib/range'
import { useLayoutMode } from '@/shell/layout'
import { useViewSearch } from '@/app/viewSearch'

/** One handler per bound action. `binding` is the matched key text ("g o", "3"). */
export type HotkeyActions = Record<ShortcutAction, (binding: string) => void>

/**
 * What each registered shortcut does. A Record over every ShortcutAction, so
 * adding an action to the registry fails to compile until it is handled here.
 */
export function useHotkeyActions(): HotkeyActions {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const search = useViewSearch()
  const shell = useShell()
  const live = useLive()
  const prefs = usePrefs()
  const [range, setRange] = useRange()
  const { drawer } = useLayoutMode()

  // Next / previous problem is a Needs attention feature: no other screen listens for it.
  const jumpToProblem = (direction: 1 | -1) => {
    if (navItemForPath(pathname)?.id !== 'overview') return
    window.dispatchEvent(
      new CustomEvent<NextProblemDetail>(NEXT_PROBLEM_EVENT, { detail: { direction } }),
    )
  }

  return {
    palette: shell.openPalette,
    shortcuts: shell.openShortcuts,
    sidebar: () => (drawer ? shell.setMobileNavOpen(true) : shell.toggleSidebar()),
    pause: live.togglePause,
    refresh: live.refresh,
    'range-next': () => setRange(stepRange(range, 1)),
    'range-prev': () => setRange(stepRange(range, -1)),
    timezone: prefs.toggleTz,
    // Overlays are exclusive, so at most one of these is open.
    dismiss: () => {
      if (shell.paletteOpen) shell.closePalette()
      else if (shell.shortcutsOpen) shell.closeShortcuts()
      else if (shell.mobileNavOpen) shell.setMobileNavOpen(false)
    },
    go: (binding) => {
      const item = NAV_ITEMS.find(({ chord }) => `g ${chord}` === binding)
      if (item) navigate({ pathname: item.path, search })
    },
    'focus-panel': (digit) => {
      const panel = document.querySelector<HTMLElement>(`[data-panel="${digit}"]`)
      // The planned panels fold into a collapsed <details> on small screens: open it, or the
      // focus call lands on something hidden and the key silently does nothing.
      const folded = panel?.closest('details')
      if (folded && !folded.open) folded.open = true
      panel?.focus()
    },
    'next-problem': () => jumpToProblem(1),
    'previous-problem': () => jumpToProblem(-1),
  }
}
