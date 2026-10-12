import { lazy } from 'react'
import { Route, Routes } from 'react-router'
import { NAV_ITEMS } from '@/config/nav'
import { NotFoundPage } from '@/features/placeholder/NotFoundPage'
import { ScreenPlaceholder } from '@/features/placeholder/ScreenPlaceholder'
import { AppShell } from '@/shell/AppShell'
import { DESIGN_SYSTEM_PATH } from '@/shell/screen'

// Screens load on demand so the shell paints before any screen code (or chart code) arrives.
const OverviewPage = lazy(() => import('@/features/overview/OverviewPage'))

// Development only: in a production build the condition is a constant, so the gallery
// (and its chunk) is dropped entirely.
const DesignSystemPage = import.meta.env.DEV
  ? lazy(() => import('@/features/design-system/DesignSystemPage'))
  : null

/**
 * Every screen in NAV_ITEMS is routed from day one. Only Overview is designed;
 * the rest render an honest placeholder. A screen's own sub-paths (a future
 * /servers/:id) stay with its screen, hence the trailing /*.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        {NAV_ITEMS.flatMap((item) =>
          item.id === 'overview'
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
