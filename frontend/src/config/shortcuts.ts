import { NAV_ITEMS } from './nav'

/**
 * Single registry of every keyboard shortcut. The hotkey layer binds the
 * entries that carry an `action`, and the shortcut sheet prints all of them, so
 * the documentation cannot drift from the behavior.
 *
 * Key syntax (lower case):
 *   "p"        one key; letters and digits are matched by physical key (event.code),
 *              so Greek and Cyrillic layouts work
 *   "shift+t"  modifiers joined with "+"; "mod" is Command on macOS and Ctrl elsewhere
 *   "g o"      a sequence: press g, then o within 1.2 s
 *   "?" "[" "/" punctuation, matched by the character it produces (event.key)
 *   "escape" and the other named keys the panels use (enter, home, end, arrowup, ...)
 */

/** Where a shortcut applies. The sheet prints one table per scope, in SCOPE_ORDER. */
export type ShortcutScope = 'global' | 'go' | 'overview' | 'panel' | 'palette'

export const SCOPE_ORDER: readonly ShortcutScope[] = [
  'global',
  'go',
  'overview',
  'panel',
  'palette',
]

export const SCOPE_TITLE: Record<ShortcutScope, string> = {
  global: 'Everywhere',
  go: 'Go to',
  overview: 'Overview',
  panel: 'In a focused panel or list',
  palette: 'In the command palette',
}

/** What the hotkey layer does for a bound shortcut (see app/hotkeys/useHotkeyActions). */
export type ShortcutAction =
  | 'palette'
  | 'shortcuts'
  | 'sidebar'
  | 'pause'
  | 'refresh'
  | 'range-next'
  | 'range-prev'
  | 'timezone'
  | 'dismiss'
  | 'go'
  | 'focus-panel'
  | 'next-problem'
  | 'previous-problem'

export interface Shortcut {
  label: string
  scope: ShortcutScope
  /** Alternatives: any one of them triggers the shortcut. */
  keys: readonly string[]
  /**
   * Bound by the global hotkey layer. Omitted means documentation only: the
   * focused panel, the palette or the browser handles these keys itself and
   * they are never bound globally.
   */
  action?: ShortcutAction
  /** What the sheet prints instead of every alternative ("1–6" rather than six keycaps). */
  shown?: readonly string[]
}

const GO_TO: readonly Shortcut[] = NAV_ITEMS.map((item) => ({
  label: `Go to ${item.label}`,
  scope: 'go',
  keys: [`g ${item.chord}`],
  action: 'go',
}))

export const SHORTCUTS: readonly Shortcut[] = [
  {
    label: 'Open the command palette',
    scope: 'global',
    keys: ['mod+k', '/'],
    action: 'palette',
  },
  {
    label: 'Show keyboard shortcuts',
    scope: 'global',
    keys: ['?', 'mod+/'],
    action: 'shortcuts',
  },
  {
    label: 'Collapse or expand the sidebar',
    scope: 'global',
    keys: ['[', 'mod+b'],
    action: 'sidebar',
  },
  { label: 'Pause or resume live updates', scope: 'global', keys: ['p'], action: 'pause' },
  { label: 'Refresh now', scope: 'global', keys: ['r'], action: 'refresh' },
  { label: 'Next time range', scope: 'global', keys: ['t'], action: 'range-next' },
  { label: 'Previous time range', scope: 'global', keys: ['shift+t'], action: 'range-prev' },
  { label: 'Switch between UTC and local time', scope: 'global', keys: ['z'], action: 'timezone' },
  {
    label: 'Close the topmost overlay or cancel a pending key',
    scope: 'global',
    keys: ['escape'],
    action: 'dismiss',
  },
  { label: 'Move between focus stops', scope: 'global', keys: ['tab', 'shift+tab'] },

  ...GO_TO,

  {
    label: 'Focus panel N',
    scope: 'overview',
    keys: ['1', '2', '3', '4', '5', '6'],
    shown: ['1–6'],
    action: 'focus-panel',
  },
  { label: 'Next problem', scope: 'overview', keys: ['n'], action: 'next-problem' },
  {
    label: 'Previous problem',
    scope: 'overview',
    keys: ['shift+n'],
    action: 'previous-problem',
  },

  { label: 'Move the selection down', scope: 'panel', keys: ['j', 'arrowdown'] },
  { label: 'Move the selection up', scope: 'panel', keys: ['k', 'arrowup'] },
  { label: 'Jump to the first or last row', scope: 'panel', keys: ['home', 'end'] },
  { label: "Open the selected entity's screen", scope: 'panel', keys: ['enter'] },
  { label: 'Copy the selected row as text', scope: 'panel', keys: ['y'] },
  { label: 'Cycle the severity filter', scope: 'panel', keys: ['f'] },
  { label: 'Toggle chart and table view', scope: 'panel', keys: ['v'] },
  {
    label: 'Switch tab or segment, or move the chart crosshair',
    scope: 'panel',
    keys: ['arrowleft', 'arrowright'],
  },

  { label: 'Move between results', scope: 'palette', keys: ['arrowup', 'arrowdown'] },
  { label: 'Run the highlighted result', scope: 'palette', keys: ['enter'] },
  { label: 'Cycle the scope chips', scope: 'palette', keys: ['tab'] },
  { label: 'Close and return focus', scope: 'palette', keys: ['escape'] },
]
