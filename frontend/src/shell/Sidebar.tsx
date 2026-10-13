import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useApi } from '@/api/context'
import { useShell } from '@/app/shell'
import { useSummary } from '@/app/summary'
import { isUnimplemented } from '@/config/features'
import { NAV_ITEMS, navItemForPath, type NavItem } from '@/config/nav'
import { cn } from '@/lib/cn'
import { IconButton, Kbd, ModKbd, Tooltip } from '@/ui/controls'
import { StatusGlyph } from '@/ui/status'
import { navBadge, type NavBadge } from './navBadge'
import { useFreshness } from './topbar/useFreshness'
import { APP_VERSION } from './version'
import { useViewSearch } from '@/app/viewSearch'
import { Wordmark } from '@/ui/Wordmark'

/** expanded 208px, rail 56px (icons, labels in tooltips), drawer (inside the off-canvas dialog). */
export type SidebarVariant = 'expanded' | 'rail' | 'drawer'

interface SidebarProps {
  variant: SidebarVariant
  /** Called when a link is followed (the drawer closes itself). */
  onNavigate?: () => void
}

const PLANNED_SPOKEN = 'planned, not implemented in backend'

/**
 * Primary navigation, rendered from NAV_ITEMS. The list is one tab stop: Tab
 * enters on the current screen, Up/Down/Home/End move between screens, Tab
 * leaves. Counts come from the shared summary, so they always agree with the
 * Overview; screens whose backend feature is not implemented carry a PLAN tag
 * instead of any number.
 */
export function Sidebar({ variant, onNavigate }: SidebarProps) {
  const { pathname } = useLocation()
  const search = useViewSearch()
  const summary = useSummary().data
  const { state: freshness } = useFreshness()
  const rail = variant === 'rail'

  const current = navItemForPath(pathname)
  // On a screen with no entry (the 404, the dev gallery) the first item is still the way in.
  const activeIndex = Math.max(
    0,
    NAV_ITEMS.findIndex((item) => item.id === current?.id),
  )
  // The roving stop follows focus; a new route puts it back on the current screen.
  const [roved, setRoved] = useState<{ pathname: string; index: number } | null>(null)
  const tabStop = roved?.pathname === pathname ? roved.index : activeIndex
  const links = useRef<(HTMLAnchorElement | null)[]>([])

  const onKeyDown = (event: KeyboardEvent, from: number) => {
    const last = NAV_ITEMS.length - 1
    let to: number
    switch (event.key) {
      case 'ArrowDown':
        to = from === last ? 0 : from + 1
        break
      case 'ArrowUp':
        to = from === 0 ? last : from - 1
        break
      case 'Home':
        to = 0
        break
      case 'End':
        to = last
        break
      default:
        return
    }
    event.preventDefault()
    links.current[to]?.focus()
  }

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden bg-panel',
        'transition-[width] duration-(--dur-slide) ease-(--ease-out)',
        variant === 'expanded' && 'w-52 border-r border-border',
        variant === 'rail' && 'w-14 border-r border-border',
        variant === 'drawer' && 'w-72 max-w-[85vw]',
      )}
    >
      <SidebarHeader variant={variant} />
      <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
        {NAV_ITEMS.map((item, index) => {
          const active = item.id === current?.id
          const badge = navBadge(item.id, summary, freshness)
          const planned = item.feature !== null && isUnimplemented(item.feature)
          return (
            <li key={item.id}>
              <NavRow
                item={item}
                rail={rail}
                active={active}
                badge={badge}
                planned={planned}
                tabbable={index === tabStop}
                to={{ pathname: item.path, search }}
                linkRef={(element) => {
                  links.current[index] = element
                }}
                onFocus={() => setRoved({ pathname, index })}
                onKeyDown={(event) => onKeyDown(event, index)}
                onNavigate={onNavigate}
              />
            </li>
          )
        })}
      </ul>
      <SidebarFooter variant={variant} />
    </nav>
  )
}

function SidebarHeader({ variant }: { variant: SidebarVariant }) {
  const { sidebarCollapsed, toggleSidebar, setMobileNavOpen } = useShell()
  return (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center border-b border-border',
        variant === 'rail' ? 'justify-center' : 'gap-2 px-3',
      )}
    >
      {variant === 'rail' ? null : <Wordmark />}
      {variant === 'drawer' ? (
        <IconButton
          aria-label="Close navigation"
          shortcut="Esc"
          icon={X}
          variant="ghost"
          className="ml-auto"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : (
        <IconButton
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          shortcut="["
          icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
          variant="ghost"
          className={variant === 'rail' ? undefined : 'ml-auto'}
          onClick={toggleSidebar}
        />
      )}
    </div>
  )
}

interface NavRowProps {
  item: NavItem
  rail: boolean
  active: boolean
  badge: NavBadge | null
  planned: boolean
  tabbable: boolean
  to: { pathname: string; search: string }
  linkRef: (element: HTMLAnchorElement | null) => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent) => void
  onNavigate?: () => void
}

function NavRow({
  item,
  rail,
  active,
  badge,
  planned,
  tabbable,
  to,
  linkRef,
  onFocus,
  onKeyDown,
  onNavigate,
}: NavRowProps) {
  const Icon = item.icon
  const spoken = badge ? badge.label : planned ? PLANNED_SPOKEN : null
  const chord = `g ${item.chord}`
  // The rail has no room for words: its tooltip carries the label, the state and the key.
  const tooltip = rail ? `${item.label}${spoken ? `, ${spoken}` : ''} (${chord})` : null
  // What the rail draws at the icon's corner: the worst state, or the dotted ring of a planned screen.
  const corner = badge ? badge.status : planned ? 'planned' : null

  return (
    <Tooltip content={tooltip}>
      <Link
        ref={linkRef}
        to={to}
        aria-current={active ? 'page' : undefined}
        tabIndex={tabbable ? 0 : -1}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onClick={onNavigate}
        className={cn(
          'group flex h-(--row-h) items-center gap-2 border-l-2 transition-colors duration-(--dur-fast) focus-visible:-outline-offset-2',
          rail ? 'justify-center' : 'px-2.5',
          active
            ? 'type-data-strong border-l-primary bg-primary-tint text-fg'
            : 'type-data border-l-transparent text-fg-muted hover:bg-hover hover:text-fg',
        )}
      >
        <span className="relative flex shrink-0">
          <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
          {rail && corner ? (
            <StatusGlyph status={corner} size={10} className="absolute -top-1.5 -right-2" />
          ) : null}
        </span>
        <span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{item.label}</span>
        {rail ? null : (
          <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
            {badge ? (
              <span className="type-tag flex items-center gap-1 text-fg">
                <StatusGlyph status={badge.status} size={10} />
                {badge.count === null ? null : <span className="tnum">{badge.count}</span>}
              </span>
            ) : planned ? (
              <span className="type-tag rounded-sm border border-dashed border-border-strong px-1 text-fg-muted">
                PLAN
              </span>
            ) : null}
            <Kbd className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:hidden">
              {chord}
            </Kbd>
          </span>
        )}
        {spoken ? <span className="sr-only">, {spoken}</span> : null}
      </Link>
    </Tooltip>
  )
}

function SidebarFooter({ variant }: { variant: SidebarVariant }) {
  const { source } = useApi()
  const [major, minor] = APP_VERSION.split('.')
  const version = `v${major}.${minor}`
  return (
    <div className="type-data flex shrink-0 flex-col gap-1.5 border-t border-border p-3 text-fg-faint">
      {variant === 'expanded' ? (
        <div className="flex flex-col gap-1.5 pointer-coarse:hidden">
          <p className="flex items-center gap-1">
            <ModKbd />
            <Kbd>K</Kbd>
            <span className="ml-1">commands</span>
          </p>
          <p className="flex items-center gap-1">
            <Kbd>?</Kbd>
            <span className="ml-1">shortcuts</span>
          </p>
          <p className="flex items-center gap-1">
            <Kbd>[</Kbd>
            <span className="ml-1">collapse</span>
          </p>
        </div>
      ) : null}
      <p className={variant === 'rail' ? 'text-center' : undefined}>
        {version}
        {variant === 'rail' || source !== 'mock' ? null : ' · MOCK'}
      </p>
    </div>
  )
}
