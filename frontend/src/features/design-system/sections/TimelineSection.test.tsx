import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '@/test/render'
import { TimelineSection } from './TimelineSection'

const panel = (name: string) => screen.getByRole('region', { name })
const lanes = (name: string) =>
  within(panel(name))
    .getAllByRole('listitem')
    .map((lane) => lane.getAttribute('aria-label'))

describe('TimelineSection', () => {
  it('shows the timeline at the Overview size and with every lane', () => {
    renderApp(<TimelineSection />)
    expect(lanes('Recent events, timeline')).toEqual(lanes('Recent events, all lanes'))
    expect(lanes('Recent events, all lanes')).toEqual([
      'edge-gw-02: critical incident, started 13:58, ongoing for 7 minutes',
      'pir-vpn: critical incident, started 13:43, ongoing for 22 minutes',
      'ath-db-01: critical incident, started 13:01, ongoing for 1 hour 4 minutes',
      'hc-bkp-01: warning incident, started 13:18, ongoing for 47 minutes',
      'api-02: warning incident, started 13:50, resolved after less than a minute at 13:50',
      'payments-api: warning incident, started 13:30, resolved after 28 minutes at 13:58',
      'web-02: critical incident, started 13:10, resolved after 4 minutes at 13:14',
      'acme-vpn:443: incident that began before the last hour, resolved at 13:25',
    ])
  })

  it('shows an ongoing incident that the axis cuts, and a recovery with no known start', () => {
    renderApp(<TimelineSection />)
    const all = within(panel('Recent events, all lanes'))
    expect(all.getByRole('listitem', { name: /^ath-db-01/ })).toHaveAttribute(
      'data-clipped',
      'true',
    )
    const older = all.getByRole('listitem', { name: /^acme-vpn:443/ })
    expect(older).toHaveAttribute('data-clipped', 'true')
    expect(
      older.querySelector('svg[data-status="critical"], svg[data-status="warning"]'),
    ).toBeNull()
  })

  it('says there are no incidents where the events are info only', () => {
    renderApp(<TimelineSection />)
    const none = within(panel('Recent events, no incidents'))
    expect(none.getByText('No incidents in the last 1h')).toBeInTheDocument()
    expect(none.queryByRole('list')).not.toBeInTheDocument()
  })

  it('marks every specimen planned sample data, never mock or live', () => {
    renderApp(<TimelineSection />)
    for (const name of [
      'Recent events, timeline',
      'Recent events, all lanes',
      'Recent events, no incidents',
    ]) {
      expect(panel(name)).toHaveAttribute('data-planned', 'true')
      expect(within(panel(name)).getByText('Planned')).toBeInTheDocument()
      expect(
        within(panel(name)).getByText('Sample data. Event log not implemented.'),
      ).toBeInTheDocument()
      expect(panel(name)).not.toHaveTextContent(/\blive\b/i)
    }
  })
})
