import { useSyncExternalStore } from 'react'
import { useApi } from '@/api/context'
import { useShowsDemoData } from '@/hooks/useProvenance'
import { useHotkeyState, type HotkeyMode } from '@/app/hotkeys/mode'
import { useLive, useLiveSnapshot } from '@/app/live'
import { cn } from '@/lib/cn'
import { StatusTag } from '@/ui/status'
import { useFlashMessage } from './flash'
import { nextPollText } from './nextPoll'
import { useNow } from './useNow'
import { APP_VERSION } from './version'
import { useMockScenario } from '@/app/scenario'

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** The browser's own idea of connectivity: it can miss a dead route, never reports a live one as dead. */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  )
}

const MODE_STYLE: Record<HotkeyMode, string> = {
  normal: 'bg-primary text-bg',
  insert: 'bg-fg text-bg',
  pending: 'bg-primary-tint text-primary',
  off: 'bg-raised text-fg-muted',
}

const MODE_WORD: Record<Exclude<HotkeyMode, 'pending'>, string> = {
  normal: 'NORMAL',
  insert: 'INSERT',
  off: 'KEYS OFF',
}

/** What the mode block means in words; silent in NORMAL, the state everyone expects. */
function spokenMode(mode: HotkeyMode, pending: string | null): string {
  switch (mode) {
    case 'insert':
      return 'Shortcuts suspended while typing'
    case 'off':
      return 'Single-key shortcuts are off'
    case 'pending':
      return `${pending ?? ''} pressed, waiting for the next key`
    case 'normal':
      return ''
  }
}

/**
 * The 24px tmux-style footer: the keyboard mode, where the data comes from,
 * when the next poll is due, and a transient message slot. No per-second
 * announcements: only the mode (when it needs saying) and flashed messages are
 * live regions.
 */
export function StatusBar() {
  const { source } = useApi()
  const demo = useShowsDemoData()
  const scenario = useMockScenario()
  const { mode, pending } = useHotkeyState()
  const { paused, pollMs } = useLive()
  const { lastUpdatedAt, fetching } = useLiveSnapshot()
  const now = useNow()
  const online = useOnline()
  const flash = useFlashMessage()

  const sourceLine =
    source === 'mock'
      ? `MOCK · mock://fixtures v1 · sample fleet · scenario ${scenario}`
      : demo
        ? 'Partly demo data: features not yet connected to the console API show sample figures'
        : `LIVE · ${window.location.origin}/api/v1`

  return (
    <footer className="type-chart flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel pr-3 text-fg-faint">
      <span
        aria-hidden="true"
        className={cn(
          'type-kbd flex h-full min-w-20 items-center justify-center px-2',
          MODE_STYLE[mode],
        )}
      >
        {mode === 'pending' ? `${pending}…` : MODE_WORD[mode]}
      </span>
      <output className="sr-only">{spokenMode(mode, pending)}</output>
      {demo ? (
        // Always present, whatever height the screen has: the strip above the content yields on short screens.
        <strong className="type-kbd bg-hatch shrink-0 self-stretch border-x border-border-strong px-2 leading-6 text-fg">
          DEMO DATA
        </strong>
      ) : null}
      <p className="min-w-0 flex-1 truncate">{sourceLine}</p>
      {online ? null : <StatusTag status="critical" word="OFFLINE" variant="tag" />}
      <span className="tnum shrink-0">
        {nextPollText({ paused, fetching, pollMs, lastUpdatedAt, now })}
      </span>
      <output className={flash ? 'min-w-0 truncate text-fg' : 'sr-only'}>{flash}</output>
      {flash ? null : (
        <span className="hidden shrink-0 lg:pointer-fine:inline">p pause · r refresh · ? keys</span>
      )}
      <span className="shrink-0">v{APP_VERSION}</span>
    </footer>
  )
}

/**
 * Phones have no status bar, but a message flashed from the palette ("Not
 * implemented in backend") must still be seen: it gets a one-line strip while
 * it lasts.
 */
export function FlashStrip() {
  const flash = useFlashMessage()
  return (
    <output
      className={
        flash
          ? 'type-chart shrink-0 truncate border-t border-border bg-panel px-3 py-1 text-fg'
          : 'sr-only'
      }
    >
      {flash}
    </output>
  )
}
