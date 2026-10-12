import { useId } from 'react'
import { Button, Kbd } from '@/ui/controls'

/**
 * Acknowledge, which the backend cannot do. It stays focusable and clickable
 * (aria-disabled, not disabled) so that pressing it explains why, in the
 * status bar, instead of doing nothing.
 */
export function AckButton({ onExplain }: { onExplain: () => void }) {
  const reasonId = useId()
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-disabled="true"
        aria-keyshortcuts="a"
        aria-describedby={reasonId}
        onClick={onExplain}
        className="-mr-2"
      >
        Acknowledge
        <Kbd aria-hidden="true" className="pointer-coarse:hidden">
          a
        </Kbd>
      </Button>
      <span id={reasonId} className="sr-only">
        Not implemented in the backend.
      </span>
    </>
  )
}
