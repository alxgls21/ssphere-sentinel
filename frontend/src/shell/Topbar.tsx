import { Menu as MenuIcon } from 'lucide-react'
import { useApi } from '@/api/context'
import { useShell } from '@/app/shell'
import { MockChip } from '@/ui/provenance/Chips'
import { IconButton } from '@/ui/controls'
import { BreadcrumbPrompt } from './topbar/BreadcrumbPrompt'
import { DisplayMenu } from './topbar/DisplayMenu'
import { FiltersMenu } from './topbar/FiltersMenu'
import { FreshnessChip } from './topbar/FreshnessChip'
import { PaletteTrigger } from './topbar/PaletteTrigger'
import { RefreshHairline } from './topbar/RefreshHairline'
import { ScopePicker } from './topbar/ScopePicker'
import { TimeRange } from './topbar/TimeRange'
import { UtcClock } from './topbar/UtcClock'
import { useScopeState } from './topbar/scope'

interface TopbarProps {
  /** The current screen's name: "Overview". */
  title: string
  /** Below 1280px: the screen title alone, and scope and time folded into Filters. */
  compact: boolean
  /** Below 1024px the sidebar is a drawer, and this bar carries the button that opens it. */
  drawer: boolean
}

/**
 * The 44px context bar: where am I, which slice am I looking at, how fresh is
 * it, what time is it. Its bottom hairline is the refresh progress line.
 */
export function Topbar({ title, compact, drawer }: TopbarProps) {
  const { source } = useApi()
  const { setMobileNavOpen } = useShell()
  const scope = useScopeState()
  const screen = title.toLowerCase()
  const segments = compact ? [screen] : ['sentinel', ...scope.segments, screen]

  return (
    <header className="relative z-40 flex h-11 shrink-0 items-center gap-2 bg-panel px-3">
      {drawer ? (
        <IconButton
          aria-label="Open navigation"
          icon={MenuIcon}
          variant="ghost"
          aria-haspopup="dialog"
          onClick={() => setMobileNavOpen(true)}
        />
      ) : null}
      {/* The full prompt never shrinks below its text (the selects and the search trigger give way
          first); the compact one is just a title and takes whatever is left. */}
      <div className={compact ? 'min-w-0 flex-1' : 'min-w-0 flex-[1_0_12.5rem]'}>
        <BreadcrumbPrompt segments={segments} />
      </div>
      {compact ? (
        <FiltersMenu state={scope} />
      ) : (
        <>
          <ScopePicker state={scope} />
          <TimeRange />
        </>
      )}
      <FreshnessChip />
      <UtcClock />
      {source === 'mock' ? <MockChip className="shrink-0" /> : null}
      <PaletteTrigger compact={compact} />
      <DisplayMenu />
      <RefreshHairline />
    </header>
  )
}
