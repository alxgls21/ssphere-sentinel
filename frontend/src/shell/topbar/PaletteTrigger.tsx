import { ChevronRight } from 'lucide-react'
import { useShell } from '@/app/shell'
import { cn } from '@/lib/cn'
import { isMac } from '@/lib/platform'
import { Kbd, ModKbd } from '@/ui/controls'

/** The topbar's way into the command palette, drawn like the prompt it opens. */
export function PaletteTrigger({ compact = false }: { compact?: boolean }) {
  const { openPalette } = useShell()
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-haspopup="dialog"
      aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
      aria-label="Search or run a command"
      className={cn(
        'type-prompt flex h-(--ctl-h) min-w-28 items-center gap-1.5 rounded-sm border border-border-control bg-bg pr-1.5 pl-2 text-left text-fg-faint transition-colors duration-(--dur-fast) hover:bg-hover',
        compact ? 'max-w-40 flex-[0_1_10rem]' : 'flex-[0_1_15rem]',
      )}
    >
      <ChevronRight
        size={16}
        strokeWidth={1.5}
        aria-hidden="true"
        className="shrink-0 text-primary"
      />
      <span className="min-w-0 truncate">search or run…</span>
      <span
        aria-hidden="true"
        className="ml-auto flex shrink-0 items-center gap-1 pointer-coarse:hidden"
      >
        <ModKbd />
        <Kbd>K</Kbd>
      </span>
    </button>
  )
}
