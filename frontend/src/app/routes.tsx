import { lazy } from 'react'
import { Route, Routes } from 'react-router'
import { RequireAuth } from './auth/RequireAuth'
import { LOGIN_PATH } from './auth/safeNext'
import LoginPage from '@/features/login/LoginPage'
import { NAV_ITEMS } from '@/config/nav'
import { NotFoundPage } from '@/features/placeholder/NotFoundPage'
import { ScreenPlaceholder } from '@/features/placeholder/ScreenPlaceholder'
import { AppShell } from '@/shell/AppShell'
import { DESIGN_SYSTEM_PATH } from '@/shell/screen'

// Screens load on demand so the shell paints before any screen code (or chart code) arrives.
const OverviewPage = lazy(() => import('@/features/overview/OverviewPage'))
const ServersListPage = lazy(() => import('@/features/servers/ServersListPage'))
const ServerDetailPage = lazy(() => import('@/features/servers/ServerDetailPage'))
const DockerPage = lazy(() => import('@/features/docker/DockerPage'))
const NetworkPage = lazy(() => import('@/features/network/NetworkPage'))
const TargetDetailPage = lazy(() => import('@/features/network/TargetDetailPage'))
const SnmpPage = lazy(() => import('@/features/snmp/SnmpPage'))
const DeviceDetailPage = lazy(() => import('@/features/snmp/DeviceDetailPage'))
const TopologyPage = lazy(() => import('@/features/topology/TopologyPage'))
const AlertsPage = lazy(() => import('@/features/alerts/AlertsPage'))
const IncidentDetailPage = lazy(() => import('@/features/alerts/IncidentDetailPage'))

// Development only: in a production build the condition is a constant, so the gallery
// (and its chunk) is dropped entirely.
const DesignSystemPage = import.meta.env.DEV
  ? lazy(() => import('@/features/design-system/DesignSystemPage'))
  : null

/**
 * Everything but /login needs a signed-in user (RequireAuth). Every screen in NAV_ITEMS is routed from day one. The designed ones (Overview,
 * Servers, Docker, Network, SNMP, Alerts) have their own routes; the rest render an honest placeholder. A
 * placeholder's own sub-paths stay with its screen, hence the trailing /*.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path={LOGIN_PATH} element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="servers">
            <Route index element={<ServersListPage />} />
            <Route path=":id" element={<ServerDetailPage />} />
          </Route>
          <Route path="docker" element={<DockerPage />} />
          <Route path="topology" element={<TopologyPage />} />
          <Route path="alerts">
            <Route index element={<AlertsPage />} />
            <Route path=":id" element={<IncidentDetailPage />} />
          </Route>
          <Route path="snmp">
            <Route index element={<SnmpPage />} />
            <Route path=":id" element={<DeviceDetailPage />} />
          </Route>
          <Route path="network">
            <Route index element={<NetworkPage />} />
            <Route path=":id" element={<TargetDetailPage />} />
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
      </Route>
    </Routes>
  )
}
