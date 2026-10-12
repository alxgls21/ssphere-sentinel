import { createContext, useContext } from 'react'

/**
 * App-frame state and actions that several parts of the UI need (hotkeys, the
 * command palette, sidebar, status bar). Implemented by shell/ShellProvider.
 * Keep this surface small: it is the contract between the shell and the rest.
 */
export interface ShellApi {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** Off-canvas navigation drawer (below 768px). */
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void

  paletteOpen: boolean
  openPalette: () => void
  closePalette: () => void

  shortcutsOpen: boolean
  openShortcuts: () => void
  closeShortcuts: () => void

  /** Speak a message through the single polite live region (rate limited). */
  announce: (message: string) => void
  /** Show a transient message in the status bar for about 4 seconds ("Acknowledge: not implemented in backend"). */
  flashStatus: (message: string) => void
}

export const ShellContext = createContext<ShellApi | null>(null)

export function useShell(): ShellApi {
  const shell = useContext(ShellContext)
  if (!shell) throw new Error('useShell must be used inside <ShellProvider>')
  return shell
}
