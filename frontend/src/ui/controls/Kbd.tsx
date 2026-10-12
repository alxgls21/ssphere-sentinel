import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'
import { isMac, modKeyLabel } from '@/lib/platform'

/**
 * A keycap: raised fill, 1px strong border. Pass `aria-hidden` when it only
 * repeats a shortcut that is already exposed another way (aria-keyshortcuts,
 * the item label).
 */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'type-kbd inline-flex min-w-4.5 items-center justify-center rounded-sm border border-border-strong bg-raised px-1 text-fg-faint',
        className,
      )}
      {...props}
    />
  )
}

/** The platform's shortcut modifier as a keycap: Command on macOS, Ctrl elsewhere. */
export function ModKbd({ className }: { className?: string }) {
  return (
    <Kbd className={className}>
      {isMac() ? (
        // The symbol is announced as a pictograph, so screen readers get the key's name.
        <>
          <span aria-hidden="true">{modKeyLabel()}</span>
          <span className="sr-only">Command</span>
        </>
      ) : (
        modKeyLabel()
      )}
    </Kbd>
  )
}
