import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import { isMac } from '@/lib/platform'
import { CHORD_TIMEOUT_MS, isTypingTarget, resolveKey } from './engine'
import { HotkeyContext, type HotkeyMode, type HotkeyState } from './mode'
import { useHotkeyActions } from './useHotkeyActions'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

/**
 * The one global keyboard layer. It listens on window in the bubble phase, so
 * a control that already handled a key (a menu's typeahead, a segmented
 * control's arrows) marks the event handled and the layer stays out of its way.
 */
export function HotkeyProvider({ children }: { children: ReactNode }) {
  const actions = useHotkeyActions()
  const { singleKeyShortcuts } = usePrefs()
  const { paletteOpen, shortcutsOpen, mobileNavOpen } = useShell()
  const overlayOpen = paletteOpen || shortcutsOpen || mobileNavOpen

  const [pending, setPending] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)

  // The listener is attached once; it reads the latest values from here.
  const latest = useRef({ actions, singleKeyShortcuts, overlayOpen })
  useEffect(() => {
    latest.current = { actions, singleKeyShortcuts, overlayOpen }
  })

  useEffect(() => {
    // Mirrors `pending` so two quick key presses never read a stale state.
    let waiting: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (keys: string | null) => {
      clearTimeout(timer)
      waiting = keys
      setPending(keys)
      if (keys !== null) timer = setTimeout(() => wait(null), CHORD_TIMEOUT_MS)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (MODIFIER_KEYS.has(event.key)) return
      const current = latest.current
      const result = resolveKey(event, waiting, {
        mac: isMac(),
        typing: isTypingTarget(event.target),
        singleKeys: current.singleKeyShortcuts,
        overlayOpen: current.overlayOpen,
      })
      switch (result.type) {
        case 'pending':
          event.preventDefault()
          wait(result.keys)
          return
        case 'cancel':
          // The key keeps its normal meaning: a stray "g" must not swallow Tab.
          wait(null)
          return
        case 'run':
          // Escape still has to reach the dialog or control it is closing.
          if (result.action !== 'dismiss') event.preventDefault()
          wait(null)
          current.actions[result.action](result.binding)
          return
        case 'ignore':
          return
      }
    }
    const onFocusIn = (event: FocusEvent) => setTyping(isTypingTarget(event.target))
    const onFocusOut = () => setTyping(false)

    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  const mode: HotkeyMode =
    pending !== null ? 'pending' : typing ? 'insert' : singleKeyShortcuts ? 'normal' : 'off'
  const state = useMemo<HotkeyState>(() => ({ mode, pending }), [mode, pending])
  return <HotkeyContext.Provider value={state}>{children}</HotkeyContext.Provider>
}
