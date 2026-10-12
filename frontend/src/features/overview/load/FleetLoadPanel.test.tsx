import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetLoad, FleetLoadOptions, LoadMetric } from '@/api/types'
import { createTestApi, renderApp } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import { FleetLoadPanel } from './FleetLoadPanel'

const SAMPLED = '2026-10-12T14:05:03Z'

const loadOf = (metric: LoadMetric, excluded: string[] = ['edge-gw-02']): FleetLoad => {
  const rows: Record<LoadMetric, FleetLoad['rows']> = {
    cpu: [
      { serverId: 's1', name: 'db-prod-01', percent: 97, collectedAt: SAMPLED },
      { serverId: 's2', name: 'api-02', percent: 82, collectedAt: SAMPLED },
      { serverId: 's3', name: 'worker-03', percent: 71, collectedAt: SAMPLED },
      { serverId: 's4', name: 'mon-01', percent: 4.2, collectedAt: SAMPLED },
    ],
    memory: [
      { serverId: 's3', name: 'worker-03', percent: 64, collectedAt: SAMPLED },
      { serverId: 's2', name: 'api-02', percent: 58, collectedAt: SAMPLED },
    ],
    disk: [{ serverId: 's1', name: 'db-prod-01', percent: 91, collectedAt: SAMPLED }],
  }
  return { generatedAt: SAMPLED, rows: rows[metric], excluded }
}

const apiServing = (
  serve: (options: FleetLoadOptions) => Promise<FleetLoad> = async (o) => loadOf(o.metric),
) => createTestApi({ getFleetLoad: vi.fn(serve) })

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent)

afterEach(() => vi.restoreAllMocks())

describe('FleetLoadPanel', () => {
  it('is panel [3]: a solid, labelled region marked NOW and mock, with the metric tabs in its header', async () => {
    renderApp(<FleetLoadPanel />, { api: apiServing() })
    const region = screen.getByRole('region', { name: 'Fleet load' })
    expect(region).toHaveAttribute('aria-keyshortcuts', '3')
    expect(region).not.toHaveAttribute('data-planned')
    expect(within(region).getByText('NOW')).toBeInTheDocument()
    expect(within(region).getByText(/^mock/)).toBeInTheDocument()
    expect(within(region).getByRole('tablist', { name: 'Load metric' })).toBeInTheDocument()
    expect(tabNames()).toEqual(['CPU', 'RAM', 'DISK'])
    expect(screen.getByRole('tab', { name: 'CPU' })).toHaveAttribute('aria-selected', 'true')
    await screen.findByRole('tabpanel')
  })

  it('takes its place in the Overview grid through className', async () => {
    renderApp(<FleetLoadPanel className="col-span-6" />, { api: apiServing() })
    expect(screen.getByRole('region', { name: 'Fleet load' })).toHaveClass('col-span-6')
    await screen.findByRole('tabpanel')
  })

  it('asks for the top 8 by CPU in the topbar scope', async () => {
    const api = apiServing()
    renderApp(<FleetLoadPanel />, { api, route: '/?customer=acme&site=athens' })
    await screen.findByRole('tabpanel')
    expect(api.getFleetLoad).toHaveBeenCalledWith({
      scope: { customerId: 'acme', siteId: 'athens' },
      metric: 'cpu',
      limit: 8,
      signal: expect.any(AbortSignal),
    })
  })

  it('draws one meter per server in the order given, named for the server and metric', async () => {
    renderApp(<FleetLoadPanel />, { api: apiServing() })
    const panel = await screen.findByRole('tabpanel', { name: 'CPU load' })
    const rows = within(panel).getAllByRole('listitem')
    expect(rows.map((row) => within(row).getByRole('meter').getAttribute('aria-label'))).toEqual([
      'CPU of db-prod-01',
      'CPU of api-02',
      'CPU of worker-03',
      'CPU of mon-01',
    ])
    expect(within(rows[1] as HTMLElement).getByText('api-02')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      '82 percent, warning',
    )
  })

  it('marks a threshold with a glyph only from 80%: triangle at warn, diamond at crit, nothing below', async () => {
    renderApp(<FleetLoadPanel />, { api: apiServing() })
    const rows = within(await screen.findByRole('tabpanel')).getAllByRole('listitem')
    const glyph = (row: HTMLElement) => row.querySelector('svg')?.getAttribute('data-status')
    expect(rows.map((row) => glyph(row as HTMLElement) ?? null)).toEqual([
      'critical',
      'warning',
      null,
      null,
    ])
  })

  it('keeps a small value readable with one decimal', async () => {
    renderApp(<FleetLoadPanel />, { api: apiServing() })
    await screen.findByRole('tabpanel')
    expect(screen.getByText('4.2%')).toBeInTheDocument()
    expect(screen.getByText('82%')).toBeInTheDocument()
  })

  it('names the servers it left out in the footer, with the UI-default thresholds', async () => {
    renderApp(<FleetLoadPanel />, { api: apiServing() })
    expect(await screen.findByText('edge-gw-02: no sample, excluded')).toBeInTheDocument()
    expect(
      screen.getByText('cell = 5% · warn at 80 · crit at 95 · UI defaults'),
    ).toBeInTheDocument()
  })

  it('says nothing about exclusions when every server has a sample', async () => {
    renderApp(<FleetLoadPanel />, { api: apiServing(async (o) => loadOf(o.metric, [])) })
    await screen.findByRole('tabpanel')
    expect(screen.queryByText(/no sample, excluded/)).not.toBeInTheDocument()
    expect(screen.getByText(/UI defaults/)).toBeInTheDocument()
  })

  describe('switching metric', () => {
    it('loads RAM and DISK from the tabs and relabels the rows', async () => {
      const user = userEvent.setup()
      const api = apiServing()
      renderApp(<FleetLoadPanel />, { api })
      await screen.findByRole('tabpanel', { name: 'CPU load' })

      await user.click(screen.getByRole('tab', { name: 'RAM' }))
      const ram = await screen.findByRole('tabpanel', { name: 'RAM load' })
      expect(screen.getByRole('tab', { name: 'RAM' })).toHaveAttribute('aria-selected', 'true')
      expect(
        within(ram)
          .getAllByRole('meter')
          .map((m) => m.getAttribute('aria-label')),
      ).toEqual(['RAM of worker-03', 'RAM of api-02'])
      expect(api.getFleetLoad).toHaveBeenLastCalledWith(
        expect.objectContaining({ metric: 'memory' }),
      )

      await user.click(screen.getByRole('tab', { name: 'DISK' }))
      const disk = await screen.findByRole('tabpanel', { name: 'Disk load' })
      expect(within(disk).getByRole('meter')).toHaveAttribute(
        'aria-valuetext',
        '91 percent, warning',
      )
      expect(api.getFleetLoad).toHaveBeenLastCalledWith(expect.objectContaining({ metric: 'disk' }))
    })

    it('moves between tabs with Left and Right, wrapping, and loads the metric each time', async () => {
      const user = userEvent.setup()
      const api = apiServing()
      renderApp(<FleetLoadPanel />, { api })
      await screen.findByRole('tabpanel', { name: 'CPU load' })

      screen.getByRole('tab', { name: 'CPU' }).focus()
      await user.keyboard('{ArrowRight}')
      expect(screen.getByRole('tab', { name: 'RAM' })).toHaveAttribute('aria-selected', 'true')
      await screen.findByRole('tabpanel', { name: 'RAM load' })

      await user.keyboard('{ArrowLeft}{ArrowLeft}')
      expect(screen.getByRole('tab', { name: 'DISK' })).toHaveAttribute('aria-selected', 'true')
      await screen.findByRole('tabpanel', { name: 'Disk load' })
    })

    it("never leaves the previous metric's rows under the new tab while it loads", async () => {
      const user = userEvent.setup()
      const memory = deferred<FleetLoad>()
      const api = apiServing((o) =>
        o.metric === 'memory' ? memory.promise : Promise.resolve(loadOf(o.metric)),
      )
      renderApp(<FleetLoadPanel />, { api })
      await screen.findByRole('tabpanel', { name: 'CPU load' })

      await user.click(screen.getByRole('tab', { name: 'RAM' }))
      expect(screen.queryByRole('meter')).not.toBeInTheDocument()
      expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Fleet load' })).toHaveAttribute(
        'aria-busy',
        'true',
      )
      // The tabs stay mounted, so the keyboard user keeps their place.
      expect(screen.getByRole('tab', { name: 'RAM' })).toHaveAttribute('aria-selected', 'true')

      await act(async () => memory.resolve(loadOf('memory')))
      expect(await screen.findByRole('tabpanel', { name: 'RAM load' })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Fleet load' })).not.toHaveAttribute('aria-busy')
    })

    it('shows the error, not the old rows, when the new metric fails to load', async () => {
      const user = userEvent.setup()
      const api = apiServing(async (o) => {
        if (o.metric === 'disk') throw new Error('telemetry unavailable')
        return loadOf(o.metric)
      })
      renderApp(<FleetLoadPanel />, { api })
      await screen.findByRole('tabpanel', { name: 'CPU load' })

      await user.click(screen.getByRole('tab', { name: 'DISK' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load fleet load')
      expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    })
  })

  describe('rows', () => {
    it('are keyboard focusable and open a tooltip naming the sample on focus', async () => {
      stubFocusVisible()
      renderApp(<FleetLoadPanel />, { api: apiServing() })
      const rows = within(await screen.findByRole('tabpanel')).getAllByRole('listitem')
      for (const row of rows) expect(row).toHaveAttribute('tabindex', '0')

      act(() => (rows[1] as HTMLElement).focus())
      const tip = await screen.findByRole('tooltip')
      expect(tip).toHaveTextContent('api-02 · CPU 82% · sampled 14:05:03Z')
      expect(rows[1]).toHaveAccessibleDescription('api-02 · CPU 82% · sampled 14:05:03Z')
    })

    it('read the sample time in local time when the operator chose it', async () => {
      stubFocusVisible()
      window.localStorage.setItem('sentinel.prefs.v1', JSON.stringify({ tz: 'local' }))
      renderApp(<FleetLoadPanel />, { api: apiServing() })
      const rows = within(await screen.findByRole('tabpanel')).getAllByRole('listitem')
      act(() => (rows[0] as HTMLElement).focus())
      const tip = await screen.findByRole('tooltip')
      expect(tip).toHaveTextContent(/db-prod-01 · CPU 97% · sampled \d{2}:\d{2}:\d{2}$/)
    })
  })

  describe('states', () => {
    it('shows a skeleton of the real row height only after a short delay, never the old content', async () => {
      const { container } = renderApp(<FleetLoadPanel />, {
        api: apiServing(() => new Promise<FleetLoad>(() => {})),
      })
      expect(screen.getByRole('region', { name: 'Fleet load' })).toHaveAttribute(
        'aria-busy',
        'true',
      )
      expect(container.querySelector('.animate-skeleton')).toBeNull()
      await waitFor(() => expect(container.querySelectorAll('.animate-skeleton')).toHaveLength(8))
      // The tabs and the footer stay: only the body is replaced.
      expect(screen.getAllByRole('tab')).toHaveLength(3)
      expect(screen.getByText(/UI defaults/)).toBeInTheDocument()
    })

    it('says so when no server has a sample, and still names the excluded ones', async () => {
      const api = apiServing(async () => ({ ...loadOf('cpu', ['edge-gw-02']), rows: [] }))
      renderApp(<FleetLoadPanel />, { api })
      expect(await screen.findByText('No load samples')).toBeInTheDocument()
      expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
      expect(screen.getByText('edge-gw-02: no sample, excluded')).toBeInTheDocument()
    })

    it('shows an inline error with Retry, and recovers', async () => {
      const user = userEvent.setup()
      let failing = true
      const api = apiServing(async (o) => {
        if (failing) throw new Error('boom')
        return loadOf(o.metric)
      })
      renderApp(<FleetLoadPanel />, { api })
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load fleet load')
      expect(screen.getByText('boom')).toBeInTheDocument()

      failing = false
      await user.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByRole('tabpanel')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
