import { useApiMode } from '@/app/mode'
import { cn } from '@/lib/cn'

/**
 * Sits above every screen that still shows built-in sample data. It says what
 * the data is, and that it is not the user's infrastructure, so a fictional
 * server can never be mistaken for a real one.
 *
 * On a short desktop window (the Overview is drawn to fit 900px with no scroll)
 * the strip steps aside rather than push the screen into a scroll; the top bar
 * chip and the status bar block still say it.
 */
export function DemoStrip({ className }: { className?: string }) {
  const mode = useApiMode()
  return (
    <aside
      aria-label="Demo data"
      className={cn(
        'bg-hatch type-data flex min-h-6 shrink-0 flex-wrap xl:[@media(max-height:57.75rem)]:hidden items-center gap-x-3 border-b border-border-strong px-3 py-0.5 text-fg',
        className,
      )}
    >
      <strong className="type-tag">DEMO DATA</strong>
      <span className="text-fg-muted">
        Sample servers and metrics, not your infrastructure.
        {mode === 'http' ? ' They ignore the customer and site filter.' : ''}
      </span>
    </aside>
  )
}
