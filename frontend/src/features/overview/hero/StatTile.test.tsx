import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import { PlannedBar, StatTile, type StatTileProps, type TileContent } from './StatTile'

const overrides = registryOverrides()
afterEach(() => {
  vi.useRealTimers()
  overrides.restore()
})

const content = (over: Partial<TileContent> = {}): TileContent => ({
  summary: '15 of 16 online, 1 critical',
  value: 15,
  unit: '/16 online',
  detail: <span>sub-counts</span>,
  bar: <span data-testid="bar" />,
  ...over,
})

const tile = (over: Partial<StatTileProps> = {}) => (
  <StatTile
    label="Servers"
    features="servers"
    to="/servers"
    status="success"
    content={content()}
    {...over}
  />
)

describe('StatTile (implemented domain)', () => {
  it('is one link to its screen, named in full with its provenance', () => {
    renderApp(tile())
    const link = screen.getByRole('link', {
      name: 'Servers: 15 of 16 online, 1 critical, mock data',
    })
    expect(link).toHaveAttribute('href', '/servers')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it("keeps the operator's scope and range when it links to its screen", () => {
    renderApp(tile(), { route: '/?customer=cus-1&site=site-2&range=6h' })
    expect(screen.getByRole('link', { name: /^Servers: / })).toHaveAttribute(
      'href',
      '/servers?range=6h&customer=cus-1&site=site-2',
    )
  })

  it('shows the value, its unit and the sub-counts and bar it is given', () => {
    renderApp(tile())
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('/16 online')).toBeInTheDocument()
    expect(screen.getByText('sub-counts')).toBeInTheDocument()
    expect(screen.getByTestId('bar')).toBeInTheDocument()
  })

  it('carries exactly one provenance marker: the quiet mock tag', () => {
    renderApp(tile())
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(screen.queryByText('Planned')).not.toBeInTheDocument()
    expect(screen.getAllByText(/^(mock|Planned|live)$/)).toHaveLength(1)
  })

  it('keeps the mock wording over an HTTP adapter while the feature is not connected', () => {
    overrides.set('servers', { connected: false })
    renderApp(tile(), { api: { ...createTestApi(), source: 'http' } })
    expect(
      screen.getByRole('link', { name: 'Servers: 15 of 16 online, 1 critical, mock data' }),
    ).toBeVisible()
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(screen.queryByText('live')).not.toBeInTheDocument()
  })

  it('drops the mock wording once the feature is connected and the data is real', () => {
    overrides.set('servers', { connected: true })
    renderApp(tile(), { api: { ...createTestApi(), source: 'http' } })
    expect(screen.getByRole('link', { name: 'Servers: 15 of 16 online, 1 critical' })).toBeVisible()
    expect(screen.queryByText('mock')).not.toBeInTheDocument()
    expect(screen.getByText('live')).toBeInTheDocument()
  })

  it('says stale in words and shape, dims only the marks, and never dims the text', () => {
    renderApp(tile({ stale: true }))
    expect(screen.getByText('STALE')).toBeVisible()
    // Text keeps its contrast (60% opacity would take it below AA); the bar is a mark and may dim.
    expect(screen.getByText('15').closest('[class*="opacity-60"]')).toBeNull()
    expect(screen.getByText('/16 online').closest('[class*="opacity-60"]')).toBeNull()
    expect(screen.getByTestId('bar').closest('[class*="opacity-60"]')).not.toBeNull()
    expect(
      screen.getByRole('link', { name: 'Servers: 15 of 16 online, 1 critical, mock data, stale' }),
    ).toBeVisible()
  })

  it('stays a link while loading, shows a skeleton only after 150 ms, and marks itself busy', () => {
    vi.useFakeTimers()
    const { container } = renderApp(tile({ status: 'loading', content: undefined }))
    const link = screen.getByRole('link', { name: 'Servers: loading, mock data' })
    expect(link).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('.animate-skeleton')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(container.querySelector('.animate-skeleton')).not.toBeNull()
  })

  it('replaces the link with an inline error and Retry when there is no data', async () => {
    const onRetry = vi.fn()
    renderApp(tile({ status: 'error', content: undefined, onRetry }))
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load Servers')
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Servers' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('StatTile value flash', () => {
  it('flashes when the number changes and not before', () => {
    const { rerender } = renderApp(tile())
    expect(screen.getByText('15')).not.toHaveClass('animate-flash')
    rerender(tile({ content: content({ value: 14 }) }))
    expect(screen.getByText('14')).toHaveClass('animate-flash')
  })

  it('does not flash an unchanged value when other things change', () => {
    const { rerender } = renderApp(tile())
    rerender(tile({ content: content({ unit: '/17 online' }) }))
    expect(screen.getByText('15')).not.toHaveClass('animate-flash')
  })

  it('does not flash for the first value after loading', () => {
    const { rerender } = renderApp(tile({ status: 'loading', content: undefined }))
    rerender(tile())
    expect(screen.getByText('15')).not.toHaveClass('animate-flash')
  })

  it('restarts the flash for a second change', () => {
    const { rerender } = renderApp(tile())
    rerender(tile({ content: content({ value: 14 }) }))
    const first = screen.getByText('14')
    rerender(tile({ content: content({ value: 13 }) }))
    const second = screen.getByText('13')
    expect(second).toHaveClass('animate-flash')
    // A new element is what restarts a CSS animation.
    expect(second).not.toBe(first)
  })
})

describe('StatTile (placeholder)', () => {
  const planned = (over: Partial<StatTileProps> = {}) =>
    tile({
      label: 'Devices',
      features: 'snmp',
      to: '/snmp',
      content: content({
        summary: '12 in inventory, no SNMP data',
        value: 12,
        unit: 'in inventory',
        bar: <PlannedBar />,
      }),
      ...over,
    })

  it('is not a link and, for SNMP, reads as not connected to the console: configuring it does not enable it here', () => {
    const { container } = renderApp(planned())
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('Not connected to the console yet')).toBeInTheDocument()
    expect(screen.queryByText('Planned, not implemented')).not.toBeInTheDocument()
    expect(container.querySelector('[data-planned="true"]')).not.toBeNull()
  })

  it('says PLANNED, not "not connected", for a feature the backend does not implement', () => {
    const { container } = renderApp(planned({ features: 'alerts', to: '/alerts' }))
    expect(screen.getByText('Planned, not implemented')).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.queryByText('Demo')).not.toBeInTheDocument()
    expect(container.querySelector('[data-planned="true"]')).not.toBeNull()
  })

  it('carries the short NOT CONNECTED chip, with its reason, and no mock tag', () => {
    renderApp(planned())
    expect(screen.getByText('Demo')).toHaveAttribute(
      'title',
      expect.stringContaining('configuring SNMP does not make data appear in this console'),
    )
    expect(screen.queryByText('mock')).not.toBeInTheDocument()
  })

  it('draws no figure, even when handed one: a dashed frame, a sentence and a dashed bar', () => {
    const { container } = renderApp(planned())
    expect(screen.queryByText('12')).not.toBeInTheDocument()
    expect(screen.queryByText('in inventory')).not.toBeInTheDocument()
    expect(container.querySelector('.type-kpi')).toBeNull()
    expect(screen.getByText('Not served by the console API')).toBeInTheDocument()
    expect(container.querySelector('[data-planned]')).toHaveClass('border-dashed')
    expect(container.querySelector('span[aria-hidden="true"].border-dashed')).not.toBeNull()
  })

  it('says it is not implemented in the backend, for a feature that is not', () => {
    renderApp(planned({ features: 'alerts', to: '/alerts' }))
    expect(screen.getByText('Not implemented in the backend')).toBeInTheDocument()
  })

  it('still shows an inline error with Retry', async () => {
    const onRetry = vi.fn()
    renderApp(planned({ status: 'error', content: undefined, onRetry }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading Devices' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
