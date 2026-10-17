import { describe, expect, it } from 'vitest'
import type { TargetReason } from '@/api/types'
import { item, iso, measurement, NOW } from '@/features/network/testing'
import {
  DEFAULT_TARGET_LIMITS,
  LOSS_LABEL,
  coverageText,
  endpointText,
  isCurrent,
  lossSpoken,
  lossText,
  measuredAgo,
  observedText,
  probesText,
  protocolText,
  reasonSentence,
  reasonWord,
  scheduleText,
  type TargetLimits,
} from './targets'

const LIMITS: TargetLimits = {
  latencyWarnMs: 150,
  lossWarnPercent: 2,
  critFailures: 3,
  origin: 'server',
}

describe('the loss metric is named for what the protocol measures', () => {
  it('calls it packet loss for ICMP and failed connection attempts for TCP', () => {
    expect(LOSS_LABEL.icmp).toBe('Packet loss')
    expect(LOSS_LABEL.tcp).toBe('Failed connection attempts')
  })

  it('writes the cell as lost for ICMP and failed for TCP, never packet loss for a TCP target', () => {
    expect(lossText('icmp', 2)).toBe('2.0% lost')
    expect(lossText('tcp', 2)).toBe('2.0% failed')
    expect(lossText('icmp', 25)).toBe('25% lost')
    expect(lossText('icmp', 0)).toBe('0.0% lost')
    expect(lossText('tcp', null)).toBe('—')
    expect(lossText('tcp', 50)).not.toMatch(/packet|lost/i)
  })

  it('speaks it in full, per protocol', () => {
    expect(lossSpoken('icmp', 2)).toBe('packet loss 2.0 percent')
    expect(lossSpoken('tcp', 2)).toBe('failed connection attempts 2.0 percent')
    expect(lossSpoken('tcp', null)).toBe('failed connection attempts not measured')
  })

  it('counts the probes of a round in the protocol’s own words', () => {
    expect(probesText(measurement({ successfulProbes: 3, probeCount: 4 }), 'icmp')).toBe(
      '3 of 4 probe packets answered',
    )
    expect(probesText(measurement({ successfulProbes: 2, probeCount: 3 }), 'tcp')).toBe(
      '2 of 3 connection attempts answered',
    )
  })
})

describe('the tag word of a reason', () => {
  const words: Record<TargetReason, string> = {
    disabled: 'DISABLED',
    no_agent: 'NO AGENT',
    agent_offline: 'AGENT OFFLINE',
    no_measurement: 'NO DATA',
    stale: 'STALE',
    failing: 'FAILING',
    failed: 'FAILED',
    latency: 'SLOW',
    loss: 'LOSS',
    ok: 'OK',
  }
  it.each(Object.entries(words) as [TargetReason, string][])('%s reads %s', (reason, word) => {
    expect(reasonWord(reason, 'icmp')).toBe(word)
  })

  it('names a loss reason for a TCP target as failures, not loss', () => {
    expect(reasonWord('loss', 'tcp')).toBe('FAILURES')
  })

  it('keeps the six situations an operator must tell apart as six different words', () => {
    const six = [
      'disabled',
      'no_agent',
      'agent_offline',
      'no_measurement',
      'stale',
      'failing',
    ] as const
    expect(new Set(six.map((reason) => reasonWord(reason, 'icmp'))).size).toBe(6)
  })
})

describe('a current reading', () => {
  it('is only a measurement the API judged health from', () => {
    for (const reason of ['ok', 'latency', 'loss', 'failed', 'failing'] as const) {
      expect(isCurrent(item({ reason })), reason).toBe(true)
    }
    for (const reason of [
      'disabled',
      'no_agent',
      'agent_offline',
      'no_measurement',
      'stale',
    ] as const) {
      expect(isCurrent(item({ reason })), reason).toBe(false)
    }
  })

  it('is never a measurement that is marked stale, whatever the reason says', () => {
    const entry = { ...item({ reason: 'ok' }), stale: true }
    expect(isCurrent(entry)).toBe(false)
  })
})

describe('reasonSentence', () => {
  const say = (entry: ReturnType<typeof item>) => reasonSentence(entry, NOW, LIMITS)

  it('says each situation in its own words', () => {
    expect(say(item({ reason: 'disabled' }))).toMatch(/switched off/)
    expect(say(item({ reason: 'no_agent', agent: 'none' }))).toBe(
      'No agent is assigned to measure this target.',
    )
    expect(say(item({ reason: 'agent_offline' }))).toMatch(/disabled or has stopped reporting/)
    expect(say(item({ reason: 'agent_offline', agent: 'unknown' }))).toMatch(/never reported/)
    expect(say(item({ reason: 'no_measurement' }))).toBe('Nothing has been measured yet.')
    expect(say(item({ reason: 'ok' }))).toBe('It answered within the limits.')
  })

  it('says a stale measurement is the last one and not a current reading, with its age', () => {
    const entry = item({ reason: 'stale', latest: measurement({ measuredAt: iso(3 * 3600) }) })
    const sentence = say(entry)
    expect(sentence).toMatch(/3h old/)
    expect(sentence).toMatch(/not a current reading/)
  })

  it('quotes the number of failures in a row from the limits, and does not invent one without', () => {
    expect(say(item({ reason: 'failing' }))).toBe('The latest 3 measurements all failed.')
    expect(reasonSentence(item({ reason: 'failing' }), NOW, DEFAULT_TARGET_LIMITS)).toBe(
      'The latest measurements all failed.',
    )
    expect(say(item({ reason: 'failed' }))).toBe('The latest measurement failed.')
  })

  it('quotes the measurement and the limit for a slow target', () => {
    const entry = item({ reason: 'latency', latest: measurement({ latencyMs: 212 }) })
    expect(say(entry)).toBe('Latency 212 ms is at or above the 150 ms warning limit.')
  })

  it('words a lossy ICMP target as packet loss and a lossy TCP target as failed attempts', () => {
    const icmp = item({ reason: 'loss', latest: measurement({ lossPercent: 6 }) })
    expect(say(icmp)).toBe('Packet loss 6.0% is at or above the 2% warning limit.')
    const tcp = item({ protocol: 'tcp', reason: 'loss', latest: measurement({ lossPercent: 6 }) })
    expect(say(tcp)).toBe('6.0% of connection attempts failed, at or above the 2% warning limit.')
    expect(say(tcp)).not.toMatch(/packet/i)
  })
})

describe('the plain facts', () => {
  it('writes the protocol, the endpoint and the schedule', () => {
    expect(protocolText(item())).toBe('ICMP')
    expect(protocolText(item({ protocol: 'tcp' }))).toBe('TCP 443')
    expect(endpointText(item())).toBe('10.20.0.1')
    expect(endpointText(item({ protocol: 'tcp' }))).toBe('api.example.net:443')
    expect(scheduleText(item())).toBe('every 60 s, timeout 5 s')
  })

  it('says how long ago, or never', () => {
    expect(measuredAgo(null, NOW)).toBe('never')
    expect(measuredAgo(measurement({ measuredAt: iso(120) }), NOW)).toBe('2m ago')
  })
})

describe('observed availability', () => {
  const availability = {
    from: iso(86_400),
    to: iso(0),
    measurements: 1400,
    successful: 1393,
    percent: 99.5,
    expectedMeasurements: 1440,
    coveragePercent: 97.2,
  }

  it('says the share of the measurements taken that succeeded, with the count', () => {
    expect(observedText(availability)).toBe('99.5% of 1,400 measurements succeeded')
  })

  it('shows coverage apart, against what the interval would give', () => {
    expect(coverageText(availability)).toBe('97% of the window measured (1,400 of 1,440 expected)')
  })

  it('says there are no measurements instead of 0% or 100%', () => {
    const none = {
      ...availability,
      measurements: 0,
      successful: 0,
      percent: null,
      coveragePercent: 0,
    }
    expect(observedText(none)).toBe('No measurements in the last 24 hours')
    expect(coverageText(none)).toBe('0% of the window measured (0 of 1,440 expected)')
  })

  it('never calls itself an SLA, an uptime or a guarantee', () => {
    for (const words of [observedText(availability), coverageText(availability)]) {
      expect(words).not.toMatch(/sla|uptime|guarantee|compliance/i)
    }
  })
})
