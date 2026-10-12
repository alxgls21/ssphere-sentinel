import { createContext, useContext } from 'react'

/**
 * The transient status-bar message (ShellApi.flashStatus), or null. A separate
 * context from ShellApi so a message appearing never re-renders the sidebar
 * or the topbar.
 */
export const FlashContext = createContext<string | null>(null)

export function useFlashMessage(): string | null {
  return useContext(FlashContext)
}
