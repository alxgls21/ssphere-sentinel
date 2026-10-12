import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useShell } from '@/app/shell'
import { NAV_ITEMS } from '@/config/nav'
import { stubFocusVisible } from '@/ui/controls/testing'
import { Sidebar, type SidebarVariant } from './Sidebar'
import { makeSummary, renderShell } from './testing'

afterEach(() => vi.restoreAllMocks())

const SUMMARY = makeSummary({
  servers: { critical: 1, warning: 2 },
  containers: { critical: 2 },
  targets: { warning: 2 },
})

/** The sidebar the way AppShell mounts it: its width follows the shell's collapsed state. */
function Harness({ variant }: { variant?: SidebarVariant }) {
  const { sidebarCollapsed } = useShell()
  return <Sidebar variant={variant ?? (sidebarCollapsed ? 'rail' : 'expanded')} />
}

async function setup(options: Parameters<typeof renderShell>[1] = {}, variant?: SidebarVariant) {
  renderShell(<Harness variant={variant} />, { summary: SUMMARY, ...options })
  // The summary arrives after the first render.
  await screen.findByRole('link', { name: 'Servers, 1 critical' })
}

const nav = () => screen.getByRole('navigation', { name: 'Primary' })
const links = () => within(nav()).getAllByRole('link')

describe('Sidebar: items', () => {
  it('lists every screen in NAV_ITEMS order, as links to its path', async () => {
    await setup()
    expect(links()).toHaveLength(NAV_ITEMS.length)
    NAV_ITEMS.forEach((item, index) => {
      expect(links()[index]).toHaveAttribute('href', item.path)
      expect(links()[index]).toHaveTextContent(item.label)
    })
  })

  it('names a screen with its worst state: “Servers, 1 critical”', async () => {
    await setup()
    expect(screen.getByRole('link', { name: 'Servers, 1 critical' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Docker, 2 critical' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Network, 2 warning' })).toBeInTheDocument()
  })

  it('draws the badge as the status glyph plus the count, never color alone', async () => {
    await setup()
    const servers = screen.getByRole('link', { name: 'Servers, 1 critical' })
    expect(servers.querySelector('[data-status="critical"]')).not.toBeNull()
    expect(servers).toHaveTextContent('1')
    const network = screen.getByRole('link', { name: 'Network, 2 warning' })
    expect(network.querySelector('[data-status="warning"]')).not.toBeNull()
  })

  it('gives Overview and Customers no badge', async () => {
    await setup()
    for (const name of ['Overview', 'Customers & Sites']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument()
    }
  })

  it('marks SNMP, Topology and Alerts PLAN instead of showing any count', async () => {
    await setup()
    for (const name of ['SNMP', 'Topology', 'Alerts']) {
      const link = screen.getByRole('link', {
        name: `${name}, planned, not implemented in backend`,
      })
      expect(link).toHaveTextContent('PLAN')
      expect(link.textContent).not.toMatch(/\d/)
    }
    expect(screen.getAllByText('PLAN')).toHaveLength(3)
  })

  it('shows no badge while the summary has not loaded', () => {
    renderShell(<Harness />, { api: { getOverviewSummary: () => new Promise(() => {}) } })
    expect(screen.getByRole('link', { name: 'Servers' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /critical|warning|unknown/ })).not.toBeInTheDocument()
  })

  it('shows no badge for a healthy fleet', async () => {
    const getOverviewSummary = vi.fn(async () => makeSummary())
    renderShell(<Harness />, { api: { getOverviewSummary } })
    await waitFor(() => expect(getOverviewSummary).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.getByRole('link', { name: 'Servers' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /critical|warning|unknown/ })).not.toBeInTheDocument()
  })
})

describe('Sidebar: current screen', () => {
  it('marks the current screen with aria-current=page and no other', async () => {
    await setup({ route: '/servers' })
    const current = links().filter((link) => link.getAttribute('aria-current') === 'page')
    expect(current.map((link) => link.getAttribute('href'))).toEqual(['/servers'])
  })

  it('keeps a screen current on its sub-paths', async () => {
    await setup({ route: '/docker/abc' })
    expect(screen.getByRole('link', { name: 'Docker, 2 critical' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('marks nothing on a page that is not a screen, and keeps the first item as the way in', async () => {
    await setup({ route: '/nope' })
    expect(links().some((link) => link.hasAttribute('aria-current'))).toBe(false)
    expect(links()[0]).toHaveAttribute('tabindex', '0')
  })

  it('carries the scope and range of the view to the next screen', async () => {
    await setup({ route: '/?range=6h&customer=acme' })
    expect(screen.getByRole('link', { name: 'Servers, 1 critical' })).toHaveAttribute(
      'href',
      '/servers?range=6h&customer=acme',
    )
  })
})

describe('Sidebar: one tab stop with roving focus', () => {
  it('makes only the current screen tabbable', async () => {
    await setup({ route: '/docker' })
    const tabbable = links().filter((link) => link.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toHaveAttribute('href', '/docker')
  })

  it('moves with Up, Down, Home and End, wrapping at the ends', async () => {
    await setup()
    const user = userEvent.setup()
    const all = links()
    all[0]?.focus()

    await user.keyboard('{ArrowDown}')
    expect(all[1]).toHaveFocus()
    expect(all[1]).toHaveAttribute('tabindex', '0')
    expect(all[0]).toHaveAttribute('tabindex', '-1')

    await user.keyboard('{End}')
    expect(all[all.length - 1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(all[0]).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(all[all.length - 1]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(all[0]).toHaveFocus()
  })

  it('roves the same way in the rail, where every link sits inside a tooltip', async () => {
    await setup({}, 'rail')
    const user = userEvent.setup()
    const all = links()
    all[0]?.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(all[2]).toHaveFocus()
    expect(all[2]).toHaveAttribute('tabindex', '0')
    expect(all.filter((link) => link.getAttribute('tabindex') === '0')).toHaveLength(1)
  })

  it('does not navigate by moving: Enter on the focused item does', async () => {
    await setup()
    const user = userEvent.setup()
    links()[0]?.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('link', { name: 'Servers, 1 critical' })).not.toHaveAttribute(
      'aria-current',
    )
    await user.keyboard('{Enter}')
    expect(screen.getByRole('link', { name: 'Servers, 1 critical' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('lets Tab leave the list instead of walking through it', async () => {
    renderShell(
      <>
        <Harness />
        <button type="button">after</button>
      </>,
      { summary: SUMMARY },
    )
    await screen.findByRole('link', { name: 'Servers, 1 critical' })
    const user = userEvent.setup()
    links()[0]?.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    await user.tab()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(links()[2]).toHaveFocus()
  })

  it('puts the stop back on the current screen after navigating', async () => {
    await setup()
    const user = userEvent.setup()
    links()[0]?.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    await user.keyboard('{Enter}')
    const docker = screen.getByRole('link', { name: 'Docker, 2 critical' })
    expect(docker).toHaveAttribute('aria-current', 'page')
    expect(docker).toHaveAttribute('tabindex', '0')
    expect(links().filter((link) => link.getAttribute('tabindex') === '0')).toHaveLength(1)
  })
})

describe('Sidebar: expanded and rail', () => {
  it('shows labels and a collapse button when expanded', async () => {
    await setup()
    expect(screen.getByText('SENTINEL')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
    expect(screen.getByText('v0.1 · MOCK')).toBeInTheDocument()
    for (const hint of ['commands', 'shortcuts', 'collapse']) {
      expect(screen.getByText(hint)).toBeInTheDocument()
    }
  })

  it('collapses to the rail and back from the header button', async () => {
    await setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
    expect(screen.queryByText('SENTINEL')).not.toBeInTheDocument()
    expect(screen.getByText('v0.1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(screen.getByText('SENTINEL')).toBeInTheDocument()
  })

  it('keeps every name in the rail (labels hidden visually, not removed)', async () => {
    await setup({}, 'rail')
    expect(screen.getByRole('link', { name: 'Servers, 1 critical' })).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'SNMP, planned, not implemented in backend' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Servers')).toHaveClass('sr-only')
  })

  it('marks the rail icon with the worst state, or the dotted ring when planned', async () => {
    await setup({}, 'rail')
    const servers = screen.getByRole('link', { name: 'Servers, 1 critical' })
    expect(servers.querySelector('[data-status="critical"]')).not.toBeNull()
    const snmp = screen.getByRole('link', { name: 'SNMP, planned, not implemented in backend' })
    expect(snmp.querySelector('[data-status="planned"]')).not.toBeNull()
    expect(screen.queryByText('PLAN')).not.toBeInTheDocument()
  })

  it('shows the label, the state and the g-key in a rail tooltip on keyboard focus', async () => {
    stubFocusVisible()
    await setup({}, 'rail')
    screen.getByRole('link', { name: 'Servers, 1 critical' }).focus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Servers, 1 critical (g s)')
  })

  it('has no tooltips when expanded: the words are already there', async () => {
    stubFocusVisible()
    await setup()
    screen.getByRole('link', { name: 'Servers, 1 critical' }).focus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('shows the g-key keycap of each screen without announcing it twice', async () => {
    await setup()
    const servers = screen.getByRole('link', { name: 'Servers, 1 critical' })
    expect(within(servers).getByText('g s')).toBeInTheDocument()
    expect(servers).toHaveAccessibleName('Servers, 1 critical')
  })
})

describe('Sidebar: drawer', () => {
  it('offers Close navigation instead of collapse, and no keyboard hints', async () => {
    await setup({}, 'drawer')
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sidebar/ })).not.toBeInTheDocument()
    expect(screen.queryByText('commands')).not.toBeInTheDocument()
  })

  it('reports a followed link, so the drawer can close', async () => {
    const onNavigate = vi.fn()
    renderShell(<Sidebar variant="drawer" onNavigate={onNavigate} />, { summary: SUMMARY })
    fireEvent.click(await screen.findByRole('link', { name: 'Servers, 1 critical' }))
    expect(onNavigate).toHaveBeenCalledOnce()
  })
})
