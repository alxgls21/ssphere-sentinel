import { createContext, useContext } from 'react'

/**
 * What the keyboard layer is doing, for the status bar's mode block:
 *   normal   keys are live
 *   insert   a text field has focus, single-key shortcuts are suspended
 *   pending  the first key of a sequence ("g") was pressed
 *   off      the operator turned single-key shortcuts off (Display menu)
 */
export type HotkeyMode = 'normal' | 'insert' | 'pending' | 'off'

export interface HotkeyState {
  mode: HotkeyMode
  /** The keys of the pending sequence ("g"), or null. */
  pending: string | null
}

export const HotkeyContext = createContext<HotkeyState | null>(null)

export function useHotkeyState(): HotkeyState {
  const state = useContext(HotkeyContext)
  if (!state) throw new Error('useHotkeyState must be used inside <HotkeyProvider>')
  return state
}
