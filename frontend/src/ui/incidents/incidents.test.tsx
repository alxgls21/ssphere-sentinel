import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { EngineStatus } from '@/api/types'
import { engine } from '@/features/alerts/testing'
import type { Resource } from '@/hooks/useResource'
import { renderApp } from '@/test/render'
import { EngineStatusBanner } from './EngineStatusBanner'
import { EngineStatusLine } from './EngineStatusLine'
import { IncidentStatusTag, SeverityTag } from './IncidentTags'

function resource(
  data: EngineStatus | undefined,
  over: Partial<Resource<EngineStatus>> = {},
): Resource<EngineStatus> {
  return {
    status: data === undefined ? 'loading' : 'success',
    data,
    error: null,
    isRefreshing: false,
    updatedAt: data === undefined ? null : Date.parse('2026-10-18T10:00:00Z'),
    refetch: vi.fn(),
    ...over,
  }
}
const failed = (error = new Error('503')) =>
  resource(undefined, { status: 'error', error, updatedAt: null })

describe('SeverityTag', () => {
  it('says critical and warning in the status alphabet: shape, word and tint', () => {
    const { container } = renderApp(
      <>
        <SeverityTag severity="critical" />
        <SeverityTag severity="warning" />
      </>,
    )
    expect(screen.getByText('CRIT')).toBeInTheDocument()
    expect(screen.getByText('WARN')).toBeInTheDocument()
    expect(container.querySelector('svg[data-status="critical"]')).not.toBeNull()
    expect(container.querySelector('svg[data-status="warning"]')).not.toBeNull()
  })
})

describe('IncidentStatusTag', () => {
  it.each([
    ['active', 'ACTIVE', 'Open and not yet seen by anyone.'],
    [
      'acknowledged',
      'ACKNOWLEDGED',
      'Seen by someone, and still open: the condition has not cleared.',
    ],
    ['recovered', 'RECOVERED', 'Ended: the condition cleared and the recovery was confirmed.'],
    ['closed', 'CLOSED', 'Ended without a recovery: monitoring of it ended.'],
  ] as const)('names %s by word, with its meaning on hover', (status, word, sentence) => {
    const { container } = renderApp(<IncidentStatusTag status={status} />)
    const tag = container.querySelector('[data-incident-status]') as HTMLElement
    expect(tag).toHaveAttribute('data-incident-status', status)
    expect(tag).toHaveTextContent(word)
    expect(tag).toHaveAttribute('title', sentence)
    expect(tag.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('tells all four apart by mark, not only by word or colour', () => {
    const { container } = renderApp(
      <>
        {(['active', 'acknowledged', 'recovered', 'closed'] as const).map((status) => (
          <IncidentStatusTag key={status} status={status} />
        ))}
      </>,
    )
    const marks = [...container.querySelectorAll('svg')].map((svg) => svg.getAttribute('class'))
    expect(new Set(marks).size).toBe(4)
  })

  it('says to a screen reader that an acknowledged incident is still open, and says it of no other', () => {
    const { container } = renderApp(
      <>
        <IncidentStatusTag status="acknowledged" />
        <IncidentStatusTag status="active" />
        <IncidentStatusTag status="closed" />
      </>,
    )
    expect(screen.getAllByText(', still open')).toHaveLength(1)
    expect(container.querySelector('[data-incident-status="acknowledged"]')).toHaveTextContent(
      'ACKNOWLEDGED, still open',
    )
  })

  it('shows recovered as the one healthy mark', () => {
    const { container } = renderApp(
      <>
        <IncidentStatusTag status="recovered" />
        <IncidentStatusTag status="active" />
      </>,
    )
    const recovered = container.querySelector('[data-incident-status="recovered"]') as HTMLElement
    const active = container.querySelector('[data-incident-status="active"]') as HTMLElement
    expect(recovered.className).toMatch(/text-healthy/)
    expect(active.className).not.toMatch(/text-healthy/)
  })
})

describe('EngineStatusBanner', () => {
  it.each([
    ['running', 'RUNNING', 'healthy'],
    ['failed', 'FAILED', 'critical'],
    ['stale', 'STALE', 'warning'],
    ['never_started', 'NEVER STARTED', 'unknown'],
  ] as const)('shows a %s engine as %s, drawn %s', (state, word, glyph) => {
    renderApp(<EngineStatusBanner resource={resource(engine(state))} />)
    const banner = screen.getByRole('region', { name: 'Alert engine' })
    expect(banner).toHaveAttribute('data-state', state)
    expect(within(banner).getByText(word)).toBeInTheDocument()
    expect(banner.querySelector(`svg[data-status="${glyph}"]`)).not.toBeNull()
  })

  it('frames a problem in its colour and a running engine in none', () => {
    const running = renderApp(<EngineStatusBanner resource={resource(engine('running'))} />)
    expect(screen.getByRole('region', { name: 'Alert engine' }).className).not.toMatch(/-line/)
    running.unmount()
    renderApp(<EngineStatusBanner resource={resource(engine('failed'))} />)
    expect(screen.getByRole('region', { name: 'Alert engine' }).className).toMatch(/critical/)
  })

  it('gives the engine’s own times, cycle and interval, and when it began monitoring', () => {
    renderApp(<EngineStatusBanner resource={resource(engine('running'))} />)
    const banner = screen.getByRole('region', { name: 'Alert engine' })
    expect(banner).toHaveTextContent('last success 12s ago')
    expect(banner).toHaveTextContent('last attempt 12s ago')
    expect(banner).toHaveTextContent('cycle 140 ms')
    expect(banner).toHaveTextContent('every 60 s')
    expect(banner).toHaveTextContent(/monitoring since/)
  })

  it('shows no time of an engine that never ran: there is none to show', () => {
    renderApp(<EngineStatusBanner resource={resource(engine('never_started'))} />)
    const banner = screen.getByRole('region', { name: 'Alert engine' })
    expect(banner).not.toHaveTextContent(/last success|last attempt|cycle|monitoring since/)
    expect(banner).toHaveTextContent(/never run/)
  })

  it('adds the caveat of an engine that is not counting silences yet', () => {
    renderApp(
      <EngineStatusBanner resource={resource(engine('running', { monitoringSince: null }))} />,
    )
    expect(screen.getByRole('region', { name: 'Alert engine' })).toHaveTextContent(
      /heartbeats are all missing at once/,
    )
  })

  it('says it is reading while the first answer is out, and then says what it cannot read, with Retry', async () => {
    const user = userEvent.setup()
    const loading = renderApp(<EngineStatusBanner resource={resource(undefined)} />)
    expect(screen.getByText(/Reading the alert engine’s state/)).toBeInTheDocument()
    loading.unmount()
    const unreadable = failed(new Error('Engine down'))
    renderApp(<EngineStatusBanner resource={unreadable} />)
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('ENGINE UNKNOWN')
    expect(banner).toHaveTextContent('Engine down')
    expect(banner).toHaveTextContent(/not known whether incidents are being evaluated/)
    await user.click(within(banner).getByRole('button', { name: 'Retry' }))
    expect(unreadable.refetch).toHaveBeenCalledOnce()
  })

  it('keeps the last answer, and says the latest read failed, when a refresh fails', () => {
    renderApp(
      <EngineStatusBanner resource={resource(engine('running'), { error: new Error('flaky') })} />,
    )
    const banner = screen.getByRole('region', { name: 'Alert engine' })
    expect(banner).toHaveTextContent('RUNNING')
    expect(banner).toHaveTextContent(/latest read of its state failed \(flaky\)/)
  })
})

describe('EngineStatusLine', () => {
  it('draws nothing for a running engine: it needs no line', () => {
    const { container } = renderApp(<EngineStatusLine resource={resource(engine('running'))} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['failed', 'FAILED'],
    ['stale', 'STALE'],
    ['never_started', 'NEVER STARTED'],
  ] as const)('says a %s engine in one line, with the whole sentence on hover', (state, word) => {
    renderApp(<EngineStatusLine resource={resource(engine(state))} />)
    const line = screen.getByText(word).closest('p') as HTMLElement
    expect(line).toHaveAttribute('title', expect.stringMatching(/\w/))
    expect(line.getAttribute('title')).toBe(
      line.querySelector(':scope > span:last-child')?.textContent,
    )
  })

  it('says its state could not be read, and draws nothing while it is still loading', () => {
    const unread = renderApp(<EngineStatusLine resource={failed(new Error('Engine down'))} />)
    expect(screen.getByText('ENGINE UNKNOWN')).toBeInTheDocument()
    expect(screen.getByText('its state could not be read')).toBeInTheDocument()
    unread.unmount()
    const { container } = renderApp(<EngineStatusLine resource={resource(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
