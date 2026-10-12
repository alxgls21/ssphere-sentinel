import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { readStorage, writeStorage } from '@/lib/storage'
import { DEFAULT_PREFS, PrefsContext, type MotionPref, type Prefs, type PrefsApi } from './prefs'
import type { Timezone } from '@/lib/format'

const KEY = 'sentinel.prefs.v1'

function load(): Prefs {
  const raw = readStorage(KEY)
  if (!raw) return DEFAULT_PREFS
  try {
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      tz: parsed.tz === 'local' ? 'local' : 'utc',
      singleKeyShortcuts: parsed.singleKeyShortcuts !== false,
      motion: parsed.motion === 'reduce' ? 'reduce' : 'system',
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** Operator display preferences, persisted locally (never required to render). */
export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load)

  useEffect(() => {
    writeStorage(KEY, JSON.stringify(prefs))
  }, [prefs])

  // Lets CSS honor the "reduce motion" override (see styles/index.css).
  useEffect(() => {
    if (prefs.motion === 'reduce') document.documentElement.setAttribute('data-motion', 'reduce')
    else document.documentElement.removeAttribute('data-motion')
  }, [prefs.motion])

  const setTz = useCallback((tz: Timezone) => setPrefs((p) => ({ ...p, tz })), [])
  const toggleTz = useCallback(
    () => setPrefs((p) => ({ ...p, tz: p.tz === 'utc' ? 'local' : 'utc' })),
    [],
  )
  const setSingleKeyShortcuts = useCallback(
    (singleKeyShortcuts: boolean) => setPrefs((p) => ({ ...p, singleKeyShortcuts })),
    [],
  )
  const setMotion = useCallback((motion: MotionPref) => setPrefs((p) => ({ ...p, motion })), [])

  const value = useMemo<PrefsApi>(
    () => ({ ...prefs, setTz, toggleTz, setSingleKeyShortcuts, setMotion }),
    [prefs, setTz, toggleTz, setSingleKeyShortcuts, setMotion],
  )
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}
