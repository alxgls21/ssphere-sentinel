import { createContext, useContext } from 'react'
import type { Timezone } from '@/lib/format'

export type MotionPref = 'system' | 'reduce'

export interface Prefs {
  /** Clock and chart timezone (key z). */
  tz: Timezone
  /** Single-key shortcuts (g o, p, r, 1-6, ...). Off satisfies WCAG 2.1.4; Ctrl/Cmd+K and Esc always work. */
  singleKeyShortcuts: boolean
  /** "reduce" forces reduced motion regardless of the OS setting. */
  motion: MotionPref
}

export interface PrefsApi extends Prefs {
  setTz: (tz: Timezone) => void
  toggleTz: () => void
  setSingleKeyShortcuts: (enabled: boolean) => void
  setMotion: (motion: MotionPref) => void
}

export const DEFAULT_PREFS: Prefs = { tz: 'utc', singleKeyShortcuts: true, motion: 'system' }

export const PrefsContext = createContext<PrefsApi | null>(null)

export function usePrefs(): PrefsApi {
  const prefs = useContext(PrefsContext)
  if (!prefs) throw new Error('usePrefs must be used inside <PrefsProvider>')
  return prefs
}
