import { Menu as MenuIcon, Search } from 'lucide-react'
import { useShowsDemoData } from '@/hooks/useProvenance'
import { useShell } from '@/app/shell'
import { IconButton } from '@/ui/controls'
import { FiltersMenu } from './topbar/FiltersMenu'
import { FreshnessCursor } from './topbar/FreshnessChip'
import { IncidentBell } from './topbar/IncidentBell'
import { RefreshHairline } from './topbar/RefreshHairline'
import { UserMenu } from './topbar/UserMenu'
import { useScopeState } from './topbar/scope'
import { Wordmark } from '@/ui/Wordmark'
import { MockChip } from '@/ui/provenance/Chips'

/**
 * The phone's 48px app bar: menu, wordmark, a compact MOCK chip, filters, search
 * and the freshness cursor. The status bar is hidden on phones, so the MOCK
 * chip is what keeps a screenshot honest.
 */
export function AppBar({ showFilters = true }: { showFilters?: boolean }) {
  const demo = useShowsDemoData()
  const { setMobileNavOpen, openPalette } = useShell()
  const scope = useScopeState()
  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center gap-2 bg-panel px-3">
      <IconButton
        aria-label="Open navigation"
        icon={MenuIcon}
        variant="ghost"
        aria-haspopup="dialog"
        onClick={() => setMobileNavOpen(true)}
      />
      <Wordmark nameYieldsOnPhones />
      <div className="ml-auto flex items-center gap-2">
        {demo ? <MockChip compact /> : null}
        {showFilters ? <FiltersMenu state={scope} iconOnly /> : null}
        <IconButton
          aria-label="Search or run a command"
          icon={Search}
          variant="ghost"
          aria-haspopup="dialog"
          onClick={openPalette}
        />
        <IncidentBell />
        <UserMenu iconOnly />
        <FreshnessCursor />
      </div>
      <RefreshHairline />
    </header>
  )
}
