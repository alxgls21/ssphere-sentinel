import { lazy } from 'react'
import { Route, Routes } from 'react-router'
import { NAV_ITEMS } from '@/config/nav'
import { NotFoundPage } from '@/features/placeholder/NotFoundPage'
import { ScreenPlaceholder } from '@/features/placeholder/ScreenPlaceholder'
import { AppShell } from '@/shell/AppShell'
import { DESIGN_SYSTEM_PATH } from '@/shell/screen'

// Screens load on demand so the shell paints before any screen code (or chart code) arrives.
const OverviewPage = lazy(() => import('@/features/overview/OverviewPage'))
const ServersListPage = lazy(() => import('@/features/servers/ServersListPage'))
const ServerDetailPage = lazy(() => import('@/features/servers/ServerDetailPage'))

// Development only: in a production build the condition is a constant, so the gallery
// (and its chunk) is dropped entirely.
const DesignSystemPage = import.meta.env.DEV
  ? lazy(() => import('@/features/design-system/DesignSystemPage'))
  : null

/**
 * Every screen in NAV_ITEMS is routed from day one. The designed ones (Overview,
 * Servers) have their own routes; the rest render an honest placeholder. A
 * placeholder's own sub-paths stay with its screen, hence the trailing /*.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="servers">
          <Route index element={<ServersListPage />} />
          <Route path=":id" element={<ServerDetailPage />} />
        </Route>
        {NAV_ITEMS.flatMap((item) =>
          item.designed
            ? []
            : [
                <Route
                  key={item.id}
                  path={`${item.path}/*`}
                  element={<ScreenPlaceholder item={item} />}
                />,
              ],
        )}
        {DesignSystemPage ? (
          <Route path={DESIGN_SYSTEM_PATH} element={<DesignSystemPage />} />
        ) : null}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
