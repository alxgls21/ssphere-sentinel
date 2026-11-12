import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderShell } from '@/shell/testing'
import { AppRoutes } from './routes'

// This file keeps its module registry between tests: the Settings layout reads the session, and a
// page loaded after a reset would read a different one than the test provides.
vi.mock('@/shell/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/features/settings/NotificationsPage', () => ({
  default: () => <p>notifications screen</p>,
}))
vi.mock('@/features/settings/AlertRulesPage', () => ({
  default: () => <p>alert rules screen</p>,
}))
vi.mock('@/features/settings/RuleEditorPage', () => ({
  default: () => <p>rule editor screen</p>,
}))
vi.mock('@/features/settings/SystemPage', () => ({
  default: () => <p>system screen</p>,
}))
vi.mock('@/features/settings/AccountPage', () => ({ default: () => <p>account screen</p> }))
vi.mock('@/features/settings/CustomersPage', () => ({ default: () => <p>customers screen</p> }))
vi.mock('@/features/settings/CustomerPage', () => ({ default: () => <p>customer screen</p> }))
vi.mock('@/features/settings/SitePage', () => ({ default: () => <p>site screen</p> }))
vi.mock('@/features/settings/TargetsPage', () => ({ default: () => <p>targets screen</p> }))
vi.mock('@/features/settings/TargetEditorPage', () => ({
  default: () => <p>target editor screen</p>,
}))
vi.mock('@/features/settings/DevicesPage', () => ({ default: () => <p>devices screen</p> }))
vi.mock('@/features/settings/DeviceEditorPage', () => ({
  default: () => <p>device editor screen</p>,
}))
vi.mock('@/features/settings/UsersPage', () => ({ default: () => <p>users screen</p> }))
vi.mock('@/features/settings/UserPage', () => ({ default: () => <p>user screen</p> }))
vi.mock('@/features/settings/AuditLogPage', () => ({ default: () => <p>audit log screen</p> }))

const main = () => screen.getByRole('main')

describe('AppRoutes: Settings', () => {
  it.each([
    ['/settings/notifications', 'notifications screen'],
    ['/settings/account', 'account screen'],
    ['/settings/alert-rules', 'alert rules screen'],
    ['/settings/alert-rules/new', 'rule editor screen'],
    ['/settings/alert-rules/6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11', 'rule editor screen'],
    ['/settings/customers', 'customers screen'],
    ['/settings/customers/new', 'customer screen'],
    ['/settings/customers/c1', 'customer screen'],
    ['/settings/sites/new', 'site screen'],
    ['/settings/sites/s1', 'site screen'],
    ['/settings/targets', 'targets screen'],
    ['/settings/targets/new', 'target editor screen'],
    ['/settings/targets/t1', 'target editor screen'],
    ['/settings/devices', 'devices screen'],
    ['/settings/devices/new', 'device editor screen'],
    ['/settings/devices/d1', 'device editor screen'],
    ['/settings/users', 'users screen'],
    ['/settings/users/new', 'user screen'],
    ['/settings/users/7', 'user screen'],
    ['/settings/audit-log', 'audit log screen'],
    ['/settings/system', 'system screen'],
  ])('lazy-loads %s inside the shell, under Settings', async (route, text) => {
    renderShell(<AppRoutes />, { route })
    expect(await within(main()).findByText(text)).toBeInTheDocument()
    expect(within(main()).getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', {
        name: 'Settings',
      }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('sends /settings to Notifications for an account that is offered nothing', async () => {
    renderShell(<AppRoutes />, { route: '/settings' })
    expect(await within(main()).findByText('notifications screen')).toBeInTheDocument()
  })

  it('titles the page Settings', async () => {
    renderShell(<AppRoutes />, { route: '/settings/system' })
    await vi.waitFor(() => expect(document.title).toContain('Settings - Sentinel'))
  })
})
