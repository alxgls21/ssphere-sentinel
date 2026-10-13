import { Suspense, useEffect, useRef, type MouseEvent } from 'react'
import { Outlet, useLocation } from 'react-router'
import { HotkeyProvider } from '@/app/hotkeys/HotkeyProvider'
import { useShell } from '@/app/shell'
import { useApi } from '@/api/context'
import { navItemForPath } from '@/config/nav'
import { SkeletonRows } from '@/ui/states'
import { AppBar } from './AppBar'
import { NavDrawer } from './NavDrawer'
import { DemoStrip } from './DemoStrip'
import { RouteBoundary } from './RouteBoundary'
import { ShortcutSheet } from './ShortcutSheet'
import { Sidebar } from './Sidebar'
import { FlashStrip, StatusBar } from './StatusBar'
import { Topbar } from './Topbar'
import { CommandPalette } from './command-palette'
import { useLayoutMode } from './layout'
import { screenTitle } from './screen'
import { useDocumentStatus } from './useDocumentStatus'

const MAIN_ID = 'main-content'

const SKIP_LINK =
  'type-data-strong sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-70 focus:rounded-sm focus:border focus:border-border-strong focus:bg-raised focus:px-3 focus:py-1.5 focus:text-primary'

/** Mounted on its own so the verdict's one-second clock never re-renders the frame. */
function DocumentStatus({ screen }: { screen: string }) {
  useDocumentStatus(screen)
  return null
}

function ScreenFallback() {
  return (
    <div>
      <output className="sr-only">Loading screen</output>
      <SkeletonRows count={6} />
    </div>
  )
}

/**
 * The application frame: skip links, the sidebar (a rail, or a drawer below
 * 1024px), the topbar (an app bar below 768px), the scrolling content with no
 * max width, and the status bar. It also mounts the keyboard layer and the two
 * overlays (command palette, shortcut sheet).
 */
export function AppShell() {
  const { pathname } = useLocation()
  const { sidebarCollapsed, mobileNavOpen, setMobileNavOpen } = useShell()
  const { phone, drawer, compact } = useLayoutMode()
  const title = screenTitle(pathname)
  const { source } = useApi()
  // A designed screen reads the sample fleet while the backend has no read API for it.
  const showsDemoData = source === 'mock' && navItemForPath(pathname)?.designed === true
  const mainRef = useRef<HTMLElement>(null)

  // A new screen starts at the top, and a screen reader is moved to it.
  const shownPath = useRef(pathname)
  useEffect(() => {
    if (shownPath.current === pathname) return
    shownPath.current = pathname
    const main = mainRef.current
    if (!main) return
    main.scrollTop = 0
    main.focus({ preventScroll: true })
  }, [pathname])

  // The drawer only exists below 1024px; growing the window must not leave it "open".
  useEffect(() => {
    if (!drawer && mobileNavOpen) setMobileNavOpen(false)
  }, [drawer, mobileNavOpen, setMobileNavOpen])

  const skipTo = (event: MouseEvent, find: () => HTMLElement | null) => {
    event.preventDefault()
    const target = find() ?? mainRef.current
    target?.focus()
  }

  return (
    <HotkeyProvider>
      <DocumentStatus screen={title} />
      <div className="flex h-dvh overflow-hidden bg-bg text-fg">
        <a
          href={`#${MAIN_ID}`}
          className={SKIP_LINK}
          onClick={(e) => skipTo(e, () => mainRef.current)}
        >
          Skip to main content
        </a>
        {navItemForPath(pathname)?.id === 'overview' ? (
          <a
            href={`#${MAIN_ID}`}
            className={SKIP_LINK}
            onClick={(e) =>
              skipTo(e, () => document.querySelector<HTMLElement>('[data-panel="1"]'))
            }
          >
            Skip to Needs attention
          </a>
        ) : null}

        {drawer ? null : <Sidebar variant={sidebarCollapsed ? 'rail' : 'expanded'} />}
        <div className="flex min-w-0 flex-1 flex-col">
          {phone ? <AppBar /> : <Topbar title={title} compact={compact} drawer={drawer} />}
          {showsDemoData ? <DemoStrip /> : null}
          <main
            id={MAIN_ID}
            ref={mainRef}
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-auto p-3 focus-visible:outline-none"
          >
            <RouteBoundary resetKey={pathname}>
              <Suspense fallback={<ScreenFallback />}>
                <Outlet />
              </Suspense>
            </RouteBoundary>
          </main>
          {phone ? <FlashStrip /> : <StatusBar />}
        </div>
      </div>
      {drawer ? <NavDrawer /> : null}
      <CommandPalette />
      <ShortcutSheet />
    </HotkeyProvider>
  )
}
