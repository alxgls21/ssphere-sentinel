import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ShellContext, type ShellApi } from '@/app/shell'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { readStorage, writeStorage } from '@/lib/storage'
import { FlashContext } from './flash'

const SIDEBAR_KEY = 'sentinel.sidebar.v1'
/** The live region speaks at most once in this window; later messages wait for it. */
const ANNOUNCE_GAP_MS = 5000
/** Pause between clearing the live region and setting the next message, so the change is observed. */
const SETTLE_MS = 80
const FLASH_MS = 4000

type Overlay = 'palette' | 'shortcuts' | 'nav'

/** The operator's saved choice, or null when they never made one (the viewport decides). */
function readCollapsed(): boolean | null {
  const raw = readStorage(SIDEBAR_KEY)
  if (raw === 'collapsed') return true
  return raw === 'expanded' ? false : null
}

/**
 * Frame state: the sidebar, the three overlays, the single polite announcer
 * and the transient status-bar message. Overlays share one slot, so opening
 * one closes the other and "Esc closes the topmost overlay" is unambiguous.
 */
export function ShellProvider({ children }: { children: ReactNode }) {
  // The reference layout (1440px and up) opens expanded; below it the rail saves the room.
  const belowWide = useMediaQuery('(width < 90rem)')
  const [chosen, setChosen] = useState<boolean | null>(readCollapsed)
  const sidebarCollapsed = chosen ?? belowWide
  const toggleSidebar = useCallback(
    () => setChosen((current) => !(current ?? belowWide)),
    [belowWide],
  )
  useEffect(() => {
    if (chosen !== null) writeStorage(SIDEBAR_KEY, chosen ? 'collapsed' : 'expanded')
  }, [chosen])

  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const openPalette = useCallback(() => setOverlay('palette'), [])
  const openShortcuts = useCallback(() => setOverlay('shortcuts'), [])
  const closePalette = useCallback(() => setOverlay((o) => (o === 'palette' ? null : o)), [])
  const closeShortcuts = useCallback(() => setOverlay((o) => (o === 'shortcuts' ? null : o)), [])
  const setMobileNavOpen = useCallback(
    (open: boolean) => setOverlay((o) => (open ? 'nav' : o === 'nav' ? null : o)),
    [],
  )

  const [spoken, setSpoken] = useState('')
  const gate = useRef<{
    lastAt: number
    timer?: ReturnType<typeof setTimeout>
    settle?: ReturnType<typeof setTimeout>
  }>({ lastAt: -Infinity })
  const announce = useCallback((message: string) => {
    const state = gate.current
    const wait = state.lastAt + ANNOUNCE_GAP_MS - Date.now()
    clearTimeout(state.timer)
    const speak = () => {
      state.lastAt = Date.now()
      // A live region only speaks when its text changes. Clearing first lets a message identical
      // to the previous one ("Updates waiting...") be heard again instead of silently dropped.
      clearTimeout(state.settle)
      setSpoken('')
      state.settle = setTimeout(() => setSpoken(message), SETTLE_MS)
    }
    // Too soon after the last one: only the newest message survives, said when the window opens.
    if (wait <= 0) speak()
    else state.timer = setTimeout(speak, wait)
  }, [])

  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flashStatus = useCallback((message: string) => {
    clearTimeout(flashTimer.current)
    setFlash(message)
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS)
  }, [])

  useEffect(() => {
    const state = gate.current
    return () => {
      clearTimeout(state.timer)
      clearTimeout(state.settle)
      clearTimeout(flashTimer.current)
    }
  }, [])

  const api = useMemo<ShellApi>(
    () => ({
      sidebarCollapsed,
      toggleSidebar,
      mobileNavOpen: overlay === 'nav',
      setMobileNavOpen,
      paletteOpen: overlay === 'palette',
      openPalette,
      closePalette,
      shortcutsOpen: overlay === 'shortcuts',
      openShortcuts,
      closeShortcuts,
      announce,
      flashStatus,
    }),
    [
      sidebarCollapsed,
      toggleSidebar,
      overlay,
      setMobileNavOpen,
      openPalette,
      closePalette,
      openShortcuts,
      closeShortcuts,
      announce,
      flashStatus,
    ],
  )

  return (
    <ShellContext.Provider value={api}>
      <FlashContext.Provider value={flash}>
        {children}
        <output aria-label="Announcements" aria-atomic="true" className="sr-only">
          {spoken}
        </output>
      </FlashContext.Provider>
    </ShellContext.Provider>
  )
}
