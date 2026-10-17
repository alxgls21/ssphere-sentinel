import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NAV_ITEMS } from '@/config/nav'
import { renderShell } from '@/shell/testing'
import { AppRoutes } from './routes'

vi.mock('@/shell/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/features/overview/OverviewPage', () => ({
  default: () => <p>overview screen</p>,
}))
vi.mock('@/features/servers/ServersListPage', () => ({
  default: () => <p>servers list screen</p>,
}))
vi.mock('@/features/servers/ServerDetailPage', () => ({
  default: () => <p>server detail screen</p>,
}))
vi.mock('@/features/network/NetworkPage', () => ({
  default: () => <p>network screen</p>,
}))
vi.mock('@/features/network/TargetDetailPage', () => ({
  default: () => <p>target screen</p>,
}))
vi.mock('@/features/snmp/SnmpPage', () => ({
  default: () => <p>snmp screen</p>,
}))
vi.mock('@/features/snmp/DeviceDetailPage', () => ({
  default: () => <p>device screen</p>,
}))
vi.mock('@/features/docker/DockerPage', () => ({
  default: () => <p>docker screen</p>,
}))
vi.mock('@/features/design-system/DesignSystemPage', () => ({
  default: () => <p>design system gallery</p>,
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const main = () => screen.getByRole('main')

describe('AppRoutes', () => {
  it('lazy-loads Overview at / inside the shell', async () => {
    renderShell(<AppRoutes />, { route: '/' })
    expect(await within(main()).findByText('overview screen')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
  })

  it('lazy-loads the Servers list and a server page inside the shell', async () => {
    const first = renderShell(<AppRoutes />, { route: '/servers' })
    expect(await within(main()).findByText('servers list screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Servers' })).toHaveAttribute('aria-current', 'page')
    first.unmount()
    renderShell(<AppRoutes />, { route: '/servers/srv-ath-db-01' })
    expect(await within(main()).findByText('server detail screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Servers' })).toHaveAttribute('aria-current', 'page')
  })

  it('lazy-loads the Docker inventory inside the shell', async () => {
    renderShell(<AppRoutes />, { route: '/docker' })
    expect(await within(main()).findByText('docker screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Docker' })).toHaveAttribute('aria-current', 'page')
  })

  it('lazy-loads the Network inventory and a target page inside the shell', async () => {
    const first = renderShell(<AppRoutes />, { route: '/network' })
    expect(await within(main()).findByText('network screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute('aria-current', 'page')
    first.unmount()
    renderShell(<AppRoutes />, { route: '/network/6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11' })
    expect(await within(main()).findByText('target screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute('aria-current', 'page')
  })

  it('lazy-loads the SNMP inventory and a device page inside the shell', async () => {
    const first = renderShell(<AppRoutes />, { route: '/snmp' })
    expect(await within(main()).findByText('snmp screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SNMP' })).toHaveAttribute('aria-current', 'page')
    first.unmount()
    renderShell(<AppRoutes />, { route: '/snmp/6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11' })
    expect(await within(main()).findByText('device screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SNMP' })).toHaveAttribute('aria-current', 'page')
  })

  it('routes every screen that is not designed yet to its placeholder', async () => {
    for (const item of NAV_ITEMS.filter((nav) => !nav.designed)) {
      const { unmount } = renderShell(<AppRoutes />, { route: item.path })
      expect(
        await within(main()).findByRole('heading', { level: 1, name: item.label }),
        item.path,
      ).toBeInTheDocument()
      expect(within(main()).getByText('This screen has not been designed yet')).toBeInTheDocument()
      unmount()
    }
  })

  it('keeps a screen’s own sub-paths with its screen', async () => {
    renderShell(<AppRoutes />, { route: '/topology/some-host' })
    expect(
      await within(main()).findByRole('heading', { level: 1, name: 'Topology' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Topology/ })).toHaveAttribute('aria-current', 'page')
  })

  it('titles each page from NAV_ITEMS', async () => {
    for (const item of NAV_ITEMS) {
      const { unmount } = renderShell(<AppRoutes />, { route: item.path })
      await vi.waitFor(() =>
        expect(document.title, item.path).toContain(`${item.label} - Sentinel`),
      )
      unmount()
    }
  })

  it('answers an unknown path with a 404 inside the shell', async () => {
    renderShell(<AppRoutes />, { route: '/nope' })
    expect(
      await within(main()).findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getAllByRole('link').some((link) => link.hasAttribute('aria-current'))).toBe(
      false,
    )
    await vi.waitFor(() => expect(document.title).toContain('Not found - Sentinel'))
  })

  it('serves the design-system gallery at /_ds in development', async () => {
    renderShell(<AppRoutes />, { route: '/_ds' })
    expect(await within(main()).findByText('design system gallery')).toBeInTheDocument()
    await vi.waitFor(() => expect(document.title).toContain('Design system - Sentinel'))
  })

  it('does not register /_ds in a production build', async () => {
    vi.stubEnv('DEV', false)
    vi.resetModules()
    // A fresh module registry: the routes module reads the environment when it loads, and
    // everything it renders into must come from the same registry (one copy of React).
    const rtl = await import('@testing-library/react')
    const { renderShell: renderFresh } = await import('@/shell/testing')
    const { AppRoutes: ProductionRoutes } = await import('./routes')
    try {
      renderFresh(<ProductionRoutes />, { route: '/_ds' })
      expect(
        await rtl.screen.findByRole('heading', { level: 1, name: 'Page not found' }),
      ).toBeInTheDocument()
      expect(rtl.screen.queryByText('design system gallery')).not.toBeInTheDocument()
    } finally {
      rtl.cleanup()
    }
  })
})
