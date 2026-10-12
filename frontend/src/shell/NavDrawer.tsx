import { useCallback, useRef } from 'react'
import { useShell } from '@/app/shell'
import { Sidebar } from './Sidebar'
import { useModalDialog } from './useModalDialog'

/**
 * The off-canvas navigation below 1024px. A native modal dialog, so focus is
 * trapped and Escape closes it; the scrim is the plain token color, no blur.
 * Following a link closes it.
 */
export function NavDrawer() {
  const { mobileNavOpen, setMobileNavOpen } = useShell()
  const ref = useRef<HTMLDialogElement>(null)
  const close = useCallback(() => setMobileNavOpen(false), [setMobileNavOpen])
  useModalDialog(ref, mobileNavOpen, close)

  return (
    <dialog
      ref={ref}
      aria-label="Navigation"
      className="top-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[85vw] border-r border-border-strong bg-panel p-0 text-fg open:flex"
    >
      {mobileNavOpen ? <Sidebar variant="drawer" onNavigate={close} /> : null}
    </dialog>
  )
}
