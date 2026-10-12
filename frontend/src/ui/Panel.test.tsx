import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '@/test/render'
import { Panel } from './Panel'
import { StatusGlyph } from './status'
import { StatusTag } from './status'

afterEach(() => vi.useRealTimers())

describe('Panel', () => {
  it('is a labelled region with a quiet source tag and a keycap hotkey', () => {
    renderApp(
      <Panel title="Needs attention" features="servers" index={1} refreshMs={15000}>
        body
      </Panel>,
    )
    const region = screen.getByRole('region', { name: 'Needs attention' })
    expect(region).toHaveAttribute('aria-keyshortcuts', '1')
    expect(region).not.toHaveAttribute('data-planned')
    expect(screen.getByText('mock · 15s')).toBeInTheDocument()
    expect(screen.queryByText('Planned')).not.toBeInTheDocument()
  })

  it('marks a panel PLANNED only when every backing feature is unimplemented', () => {
    const { rerender } = renderApp(
      <Panel title="Active alerts" features="alerts" plannedNote="Alert engine not implemented.">
        x
      </Panel>,
    )
    const region = screen.getByRole('region', { name: 'Active alerts' })
    expect(region).toHaveAttribute('data-planned', 'true')
    expect(region).toHaveAccessibleDescription(expect.stringContaining('Sample data.'))
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('Sample data. Alert engine not implemented.')).toBeInTheDocument()
    expect(screen.queryByText(/^mock/)).not.toBeInTheDocument()

    // A mixed panel (one implemented feature) is not planned.
    rerender(
      <Panel title="Mixed" features={['alerts', 'servers']}>
        x
      </Panel>,
    )
    expect(screen.queryByText('Planned')).not.toBeInTheDocument()
  })

  it('shows no skeleton for a fast load, then a skeleton after 150 ms, aria-busy throughout', () => {
    vi.useFakeTimers()
    renderApp(
      <Panel
        title="Fleet load"
        features="servers"
        status="loading"
        skeleton={<div data-testid="skel" />}
      >
        data
      </Panel>,
    )
    expect(screen.getByRole('region', { name: 'Fleet load' })).toHaveAttribute('aria-busy', 'true')
    // Assistive technology is told what is loading even before (or without) any skeleton.
    expect(screen.getByText('Loading Fleet load')).toBeInTheDocument()
    expect(screen.queryByTestId('skel')).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(screen.getByTestId('skel')).toBeInTheDocument()
    expect(screen.queryByText('data')).not.toBeInTheDocument()
  })

  it('shows an inline error with Retry when there is no data', async () => {
    const onRetry = vi.fn()
    renderApp(
      <Panel
        title="Fleet load"
        features="servers"
        status="error"
        error={new Error('boom')}
        onRetry={onRetry}
      >
        data
      </Panel>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load fleet load')
    expect(screen.getByText('boom')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('keeps stale data visible under a non-blocking banner when a refresh fails', () => {
    renderApp(
      <Panel
        title="Fleet load"
        features="servers"
        status="success"
        error={new Error('flaky')}
        updatedAt={Date.parse('2026-10-12T14:03:10Z')}
        onRetry={() => {}}
      >
        <p>last good data</p>
      </Panel>,
    )
    expect(screen.getByText('last good data')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('ERROR')
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed')
    expect(screen.getByRole('status')).toHaveTextContent('Showing data from 14:03:10Z')
  })

  it('dims content only while a reload is in flight, and labels stale in words', () => {
    const { rerender } = renderApp(
      <Panel title="Fleet load" features="servers" stale>
        <p>content</p>
      </Panel>,
    )
    expect(screen.getByText('STALE')).toBeInTheDocument()
    expect(screen.getByText('content').parentElement).not.toHaveClass('opacity-60')
    rerender(
      <Panel title="Fleet load" features="servers" refreshing>
        <p>content</p>
      </Panel>,
    )
    expect(screen.getByText('content').parentElement).toHaveClass('opacity-60')
  })

  it('marks itself STALE when its own data ages past 45 s, without dimming its text', () => {
    vi.useFakeTimers()
    renderApp(
      <Panel title="Fleet load" features="servers" updatedAt={Date.now()}>
        <p>content</p>
      </Panel>,
    )
    expect(screen.queryByText('STALE')).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(46_000)
    })
    expect(screen.getByText('STALE')).toBeInTheDocument()
    // Small text at 60% opacity would fall below AA, so persistent staleness never dims it.
    expect(screen.getByText('content').parentElement).not.toHaveClass('opacity-60')
  })

  it('renders the empty state instead of children', () => {
    renderApp(
      <Panel
        title="Needs attention"
        features="servers"
        isEmpty
        empty={<p>Nothing needs attention</p>}
      >
        rows
      </Panel>,
    )
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument()
    expect(screen.queryByText('rows')).not.toBeInTheDocument()
  })
})

describe('status alphabet', () => {
  it.each([
    ['healthy', 'OK'],
    ['warning', 'WARN'],
    ['critical', 'CRIT'],
    ['unknown', 'UNKN'],
    ['idle', 'IDLE'],
  ] as const)('%s is shape + word', (status, word) => {
    const { container } = renderApp(<StatusTag status={status} />)
    expect(screen.getByText(word)).toBeInTheDocument()
    expect(container.querySelector(`svg[data-status="${status}"]`)).toBeInTheDocument()
  })

  it('allows a domain word to replace the class word', () => {
    renderApp(<StatusTag status="critical" word="OFFLINE" />)
    expect(screen.getByText('OFFLINE')).toBeInTheDocument()
  })

  it('names a standalone glyph and hides a decorative one', () => {
    const { container } = renderApp(
      <>
        <StatusGlyph status="critical" label="critical" />
        <StatusGlyph status="healthy" />
      </>,
    )
    expect(screen.getByRole('img', { name: 'critical' })).toBeInTheDocument()
    expect(container.querySelector('svg[data-status="healthy"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })
})
