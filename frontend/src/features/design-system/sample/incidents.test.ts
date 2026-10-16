import { describe, expect, it } from 'vitest'
import { buildIncidents, countIncidents } from '@/features/overview/events/incidentModel'
import { SAMPLE_TIME } from './data'
import { SAMPLE_INCIDENT_EVENTS, SAMPLE_INFO_EVENTS } from './incidents'

describe('sample incident events', () => {
  const incidents = buildIncidents(SAMPLE_INCIDENT_EVENTS, SAMPLE_TIME)

  it('hold one of every lane: ongoing and resolved, both severities, cut off and older than the range', () => {
    expect(countIncidents(incidents)).toEqual({ ongoing: 4, resolved: 4 })
    expect(new Set(incidents.map((incident) => incident.severity))).toEqual(
      new Set(['critical', 'warning', null]),
    )
    expect(incidents.filter((incident) => incident.missingOpening === 'before-range')).toHaveLength(
      1,
    )
    const hour = 60 * 60_000
    expect(
      incidents.some((incident) => incident.start !== null && incident.start < SAMPLE_TIME - hour),
    ).toBe(true)
  })

  it('have unique ids and none in the future', () => {
    const ids = SAMPLE_INCIDENT_EVENTS.map((event) => event.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const event of SAMPLE_INCIDENT_EVENTS) {
      expect(Date.parse(event.at)).toBeLessThanOrEqual(SAMPLE_TIME)
    }
  })

  it('include events that make no incident at all', () => {
    expect(SAMPLE_INFO_EVENTS.length).toBeGreaterThan(0)
    expect(buildIncidents(SAMPLE_INFO_EVENTS, SAMPLE_TIME)).toEqual([])
  })
})
