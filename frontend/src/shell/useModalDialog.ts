import { useEffect, useRef, type RefObject } from 'react'

/**
 * Drives a native modal <dialog> from state. showModal() gives focus trapping,
 * inert background and Escape for free; this keeps the state in step:
 *
 *   - `open` true shows it, false closes it and puts focus back where it was;
 *   - the operator dismissing it natively (Escape) or by clicking the scrim
 *     calls `onClose`, so the state follows the dialog and not the reverse.
 */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  onClose: () => void,
) {
  const invoker = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      invoker.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
      // Browsers do this themselves; doing it here too keeps it deterministic (and testable).
      if (invoker.current?.isConnected) invoker.current.focus()
      invoker.current = null
    }
  }, [ref, open])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const onNativeClose = () => {
      // A dialog that was reopened meanwhile is not the one that closed.
      if (!dialog.open) onClose()
    }
    // The scrim belongs to the dialog element: a click that lands on it, not on content, is outside.
    const onScrimClick = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close()
    }
    dialog.addEventListener('close', onNativeClose)
    dialog.addEventListener('click', onScrimClick)
    return () => {
      dialog.removeEventListener('close', onNativeClose)
      dialog.removeEventListener('click', onScrimClick)
    }
  }, [ref, onClose])
}
