import {
  Activity,
  BellPlus,
  Clock,
  FlaskConical,
  Globe,
  Keyboard,
  Link,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react'
import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useApi } from '@/api/context'
import { useAuth } from '@/app/auth/auth'
import { useApiMode } from '@/app/mode'
import type { EntityIndex } from '@/api/types'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import {
  MOCK_SCENARIOS,
  MOCK_SCENARIO_SUMMARY,
  useMockScenario,
  useSetMockScenario,
} from '@/app/scenario'
import { useShell } from '@/app/shell'
import { useRange } from '@/app/viewState'
import { stepRange } from '@/lib/range'
import { copyText } from './clipboard'
import {
  entityItem,
  helpItems,
  screenItems,
  screenOf,
  type PaletteItem,
  type PaletteSource,
} from './model'

/**
 * Everything the palette can run or open, wired to the app's existing
 * contexts. The result is memoized so typing re-ranks without rebuilding it.
 */
export function usePaletteSource({
  index,
  choosePrefix,
  retry,
}: {
  index: EntityIndex | undefined
  choosePrefix: (prefix: string) => void
  /** Set while the index failed to load: offered as an action, since the banner's button is pointer-only. */
  retry: (() => void) | null
}): PaletteSource {
  const navigate = useNavigate()
  const { search } = useLocation()
  const { source: dataSource } = useApi()
  const apiMode = useApiMode()
  const { capabilities } = useAuth()
  const mayCreateRules = capabilities.createAlertRules
  const { paused, togglePause, refresh } = useLive()
  const { tz, toggleTz, singleKeyShortcuts, setSingleKeyShortcuts, motion, setMotion } = usePrefs()
  const { sidebarCollapsed, toggleSidebar, openShortcuts, flashStatus } = useShell()
  const [range, setRange] = useRange()
  const scenario = useMockScenario()
  const setScenario = useSetMockScenario()

  return useMemo(() => {
    // Screens keep the scope and range in the query string, so a jump keeps the view's filters.
    const open = (path: string) => navigate({ pathname: path, search })
    // Single-key hints are only true while those shortcuts are switched on.
    const keys = (...hint: string[]) => (singleKeyShortcuts ? hint : undefined)

    const copyLink = () => {
      void copyText(window.location.href).then((copied) =>
        flashStatus(
          copied
            ? 'Link to this view copied'
            : 'Could not copy the link: copy it from the address bar',
        ),
      )
    }

    const actions: PaletteItem[] = [
      ...(retry
        ? [
            {
              id: 'action:retry-entities',
              group: 'actions' as const,
              title: 'Retry entity search',
              subtitle: 'The entity index could not be loaded',
              icon: RefreshCw,
              keywords: ['reload', 'entities', 'index'],
              keepOpen: true,
              run: retry,
            },
          ]
        : []),
      {
        id: 'action:pause',
        group: 'actions',
        title: paused ? 'Resume updates' : 'Pause updates',
        subtitle: paused ? 'Live data is frozen' : 'Freeze the screen while you read',
        icon: paused ? Play : Pause,
        keywords: ['live', 'freeze', 'stop', 'polling'],
        hint: keys('p'),
        run: togglePause,
      },
      {
        id: 'action:refresh',
        group: 'actions',
        title: 'Refresh now',
        subtitle: 'Reload every panel',
        icon: RefreshCw,
        keywords: ['reload', 'update'],
        hint: keys('r'),
        run: refresh,
      },
      {
        id: 'action:range',
        group: 'actions',
        title: 'Next time range',
        subtitle: `${range} to ${stepRange(range, 1)}`,
        icon: Clock,
        keywords: ['window', 'period', '15m', '1h', '6h', '24h'],
        hint: keys('t'),
        run: () => setRange(stepRange(range, 1)),
      },
      {
        id: 'action:timezone',
        group: 'actions',
        title: tz === 'utc' ? 'Switch to local time' : 'Switch to UTC',
        subtitle: tz === 'utc' ? 'Showing UTC' : 'Showing local time',
        icon: Globe,
        keywords: ['timezone', 'clock'],
        hint: keys('z'),
        run: toggleTz,
      },
      {
        // WCAG 2.1.4: a way to turn single-key shortcuts off at every width (the Display menu is
        // not on the phone app bar, the palette is).
        id: 'action:single-keys',
        group: 'actions',
        title: singleKeyShortcuts
          ? 'Turn off single-key shortcuts'
          : 'Turn on single-key shortcuts',
        subtitle: 'Cmd/Ctrl+K and Esc always work',
        icon: Keyboard,
        keywords: ['keys', 'hotkeys', 'shortcuts', 'accessibility', 'voice', 'dictation'],
        run: () => setSingleKeyShortcuts(!singleKeyShortcuts),
      },
      {
        id: 'action:motion',
        group: 'actions',
        title: motion === 'reduce' ? 'Follow the system motion setting' : 'Reduce motion',
        subtitle: motion === 'reduce' ? 'Motion is reduced' : 'Turns off every animation',
        icon: Activity,
        keywords: ['animation', 'accessibility', 'vestibular'],
        run: () => setMotion(motion === 'reduce' ? 'system' : 'reduce'),
      },
      {
        id: 'action:sidebar',
        group: 'actions',
        title: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        icon: sidebarCollapsed ? PanelLeftOpen : PanelLeftClose,
        keywords: ['navigation', 'rail', 'menu'],
        hint: keys('['),
        run: toggleSidebar,
      },
      {
        id: 'action:link',
        group: 'actions',
        title: 'Copy link to this view',
        subtitle: 'Keeps the scope and time range',
        icon: Link,
        keywords: ['share', 'url', 'address'],
        run: copyLink,
      },
      {
        id: 'action:shortcuts',
        group: 'actions',
        title: 'Show shortcuts',
        icon: Keyboard,
        keywords: ['keys', 'keyboard', 'hotkeys', 'help'],
        hint: keys('?'),
        run: openShortcuts,
      },
      // Offered to an account that may create rules; the server decides again when one is saved.
      ...(mayCreateRules
        ? [
            {
              id: 'action:new-alert-rule',
              group: 'actions' as const,
              title: 'New alert rule',
              subtitle: 'Opens the rule form in Settings',
              icon: BellPlus,
              keywords: ['create', 'add', 'incident', 'condition', 'settings'],
              run: () => navigate({ pathname: '/settings/alert-rules/new' }),
            },
          ]
        : []),
    ]

    const scenarios: PaletteItem[] =
      dataSource === 'mock' && apiMode === 'mock'
        ? MOCK_SCENARIOS.map((name) => ({
            id: `scenario:${name}`,
            group: 'scenario',
            title: name,
            subtitle: MOCK_SCENARIO_SUMMARY[name],
            icon: FlaskConical,
            keywords: ['mock', 'scenario', 'demo'],
            badge: name === scenario ? 'current' : undefined,
            run: () => setScenario(name),
          }))
        : []

    const entities = (index?.items ?? []).map((entity) =>
      entityItem(entity, ({ kind, id }) =>
        // A server has a page of its own; the other kinds open the screen that owns them.
        open(
          kind === 'server'
            ? `${screenOf(kind).path}/${encodeURIComponent(id)}`
            : screenOf(kind).path,
        ),
      ),
    )

    return {
      entities: entities.filter(({ group }) => group === 'entities'),
      sites: entities.filter(({ group }) => group === 'sites'),
      'go-to': screenItems((screen) => open(screen.path), singleKeyShortcuts),
      actions,
      scenario: scenarios,
      planned: [],
      help: helpItems(choosePrefix),
    }
  }, [
    index,
    navigate,
    search,
    dataSource,
    apiMode,
    mayCreateRules,
    paused,
    togglePause,
    refresh,
    tz,
    toggleTz,
    singleKeyShortcuts,
    setSingleKeyShortcuts,
    motion,
    setMotion,
    sidebarCollapsed,
    toggleSidebar,
    openShortcuts,
    flashStatus,
    range,
    setRange,
    scenario,
    setScenario,
    choosePrefix,
    retry,
  ])
}
