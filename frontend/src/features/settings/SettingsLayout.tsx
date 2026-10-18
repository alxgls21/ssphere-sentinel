import { Link, Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '@/app/auth/auth'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { EmptyState } from '@/ui/states'
import { SECTIONS, defaultSection } from './sections'

/**
 * Settings: the section links, and the section under them. Only the sections this account is
 * offered are linked (the sample fleet has no accounts, so it is offered none); each page checks
 * for itself too, since a link can be followed by anyone and the server checks every request.
 */
export default function SettingsLayout() {
  const { capabilities } = useAuth()
  const { pathname } = useLocation()
  const viewTo = useViewTo()
  const offered = SECTIONS.filter((section) => section.offered(capabilities))

  if (pathname.replace(/\/+$/, '') === '/settings') {
    return <Navigate to={viewTo(defaultSection(capabilities).path)} replace />
  }

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-col gap-2">
        <h1 className="type-title">Settings</h1>
        {offered.length > 0 ? (
          <nav aria-label="Settings sections" className="-mx-3 overflow-x-auto px-3">
            <ul className="flex min-w-max gap-1 border-b border-border">
              {offered.map((section) => {
                const current = pathname === section.path || pathname.startsWith(`${section.path}/`)
                return (
                  <li key={section.id}>
                    <Link
                      to={viewTo(section.path)}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'type-data-strong inline-flex h-(--ctl-h) items-center border-b-2 px-3 -outline-offset-2 pointer-coarse:h-(--hit)',
                        current
                          ? 'border-primary text-fg'
                          : 'border-transparent text-fg-muted hover:bg-hover hover:text-fg',
                      )}
                    >
                      {section.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
        ) : (
          <div className="rounded-sm border border-border bg-panel">
            <EmptyState
              title="No settings for this account"
              hint="Nothing in Settings is offered to it: the sample fleet has no accounts, or the account has no permission for any section."
            />
          </div>
        )}
      </header>
      <Outlet />
    </div>
  )
}
