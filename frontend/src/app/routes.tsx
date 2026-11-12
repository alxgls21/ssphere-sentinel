import { lazy } from 'react'
import { Route, Routes } from 'react-router'
import { RequireAuth } from './auth/RequireAuth'
import { LOGIN_PATH, SETUP_PATH } from './auth/safeNext'
import LoginPage from '@/features/login/LoginPage'
import SetupPage from '@/features/login/SetupPage'
import { NAV_ITEMS } from '@/config/nav'
import { NotFoundPage } from '@/features/placeholder/NotFoundPage'
import { ScreenPlaceholder } from '@/features/placeholder/ScreenPlaceholder'
import { AppShell } from '@/shell/AppShell'
import { DESIGN_SYSTEM_PATH } from '@/shell/screen'

// Screens load on demand so the shell paints before any screen code (or chart code) arrives.
const OverviewPage = lazy(() => import('@/features/overview/OverviewPage'))
const ServersListPage = lazy(() => import('@/features/servers/ServersListPage'))
const AddServerPage = lazy(() => import('@/features/servers/AddServerPage'))
const ServerDetailPage = lazy(() => import('@/features/servers/ServerDetailPage'))
const DockerPage = lazy(() => import('@/features/docker/DockerPage'))
const NetworkPage = lazy(() => import('@/features/network/NetworkPage'))
const TargetDetailPage = lazy(() => import('@/features/network/TargetDetailPage'))
const SnmpPage = lazy(() => import('@/features/snmp/SnmpPage'))
const DeviceDetailPage = lazy(() => import('@/features/snmp/DeviceDetailPage'))
const TopologyPage = lazy(() => import('@/features/topology/TopologyPage'))
const AlertsPage = lazy(() => import('@/features/alerts/AlertsPage'))
const IncidentDetailPage = lazy(() => import('@/features/alerts/IncidentDetailPage'))
const SettingsLayout = lazy(() => import('@/features/settings/SettingsLayout'))
const NotificationsPage = lazy(() => import('@/features/settings/NotificationsPage'))
const AccountPage = lazy(() => import('@/features/settings/AccountPage'))
const AlertRulesPage = lazy(() => import('@/features/settings/AlertRulesPage'))
const RuleEditorPage = lazy(() => import('@/features/settings/RuleEditorPage'))
const CustomersPage = lazy(() => import('@/features/settings/CustomersPage'))
const CustomerPage = lazy(() => import('@/features/settings/CustomerPage'))
const SitePage = lazy(() => import('@/features/settings/SitePage'))
const TargetsPage = lazy(() => import('@/features/settings/TargetsPage'))
const TargetEditorPage = lazy(() => import('@/features/settings/TargetEditorPage'))
const DevicesPage = lazy(() => import('@/features/settings/DevicesPage'))
const DeviceEditorPage = lazy(() => import('@/features/settings/DeviceEditorPage'))
const UsersPage = lazy(() => import('@/features/settings/UsersPage'))
const UserPage = lazy(() => import('@/features/settings/UserPage'))
const AuditLogPage = lazy(() => import('@/features/settings/AuditLogPage'))
const SystemPage = lazy(() => import('@/features/settings/SystemPage'))

// Development only: in a production build the condition is a constant, so the gallery
// (and its chunk) is dropped entirely.
const DesignSystemPage = import.meta.env.DEV
  ? lazy(() => import('@/features/design-system/DesignSystemPage'))
  : null

/**
 * Everything but /login and /setup needs a signed-in user (RequireAuth). Every screen in NAV_ITEMS is routed from day one. The designed ones (Overview,
 * Servers, Docker, Network, SNMP, Alerts, Settings) have their own routes; the rest render an honest placeholder. A
 * placeholder's own sub-paths stay with its screen, hence the trailing /*.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path={LOGIN_PATH} element={<LoginPage />} />
      <Route path={SETUP_PATH} element={<SetupPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="servers">
            <Route index element={<ServersListPage />} />
            <Route path="new" element={<AddServerPage />} />
            <Route path=":id" element={<ServerDetailPage />} />
          </Route>
          <Route path="docker" element={<DockerPage />} />
          <Route path="topology" element={<TopologyPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="alert-rules" element={<AlertRulesPage />} />
            <Route path="alert-rules/new" element={<RuleEditorPage />} />
            <Route path="alert-rules/:id" element={<RuleEditorPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="customers/new" element={<CustomerPage />} />
            <Route path="customers/:id" element={<CustomerPage />} />
            <Route path="sites/new" element={<SitePage />} />
            <Route path="sites/:id" element={<SitePage />} />
            <Route path="targets" element={<TargetsPage />} />
            <Route path="targets/new" element={<TargetEditorPage />} />
            <Route path="targets/:id" element={<TargetEditorPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="devices/new" element={<DeviceEditorPage />} />
            <Route path="devices/:id" element={<DeviceEditorPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="users/new" element={<UserPage />} />
            <Route path="users/:id" element={<UserPage />} />
            <Route path="audit-log" element={<AuditLogPage />} />
            <Route path="system" element={<SystemPage />} />
          </Route>
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
