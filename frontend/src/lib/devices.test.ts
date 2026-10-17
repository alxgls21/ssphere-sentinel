import { describe, expect, it } from 'vitest'
import type { DeviceReason, InterfaceReason } from '@/api/types'
import { iface, item, iso, noRates, NOW, rates } from '@/features/snmp/testing'
import {
  DEVICE_TYPE_LABEL,
  deviceReasonSentence,
  deviceReasonWord,
  interfaceCountsSpoken,
  interfaceCountsText,
  interfaceReasonSentence,
  interfaceReasonWord,
  interfaceStateText,
  interfaceTitle,
  invalidSentence,
  isCurrentDevice,
  pollErrorText,
  pollScheduleText,
  polledAgo,
  rateText,
  responseText,
  snmpText,
  speedText,
} from './devices'

describe('the tag word of a device’s reason', () => {
  const words: Record<DeviceReason, string> = {
    disabled: 'DISABLED',
    no_agent: 'NO AGENT',
    agent_offline: 'AGENT OFFLINE',
    no_poll: 'NOT POLLED',
    stale: 'STALE',
    unreachable: 'UNREACHABLE',
    ok: 'REACHABLE',
  }
  it.each(Object.entries(words) as [DeviceReason, string][])('%s reads %s', (reason, word) => {
    expect(deviceReasonWord(reason)).toBe(word)
  })

  it('keeps every situation an operator must tell apart as a different word', () => {
    expect(new Set(Object.keys(words).map((r) => deviceReasonWord(r as DeviceReason))).size).toBe(7)
  })
})

describe('a current device', () => {
  it('is a poll the API judged health from: reached or not reached, and not stale', () => {
    expect(isCurrentDevice(item({ reason: 'ok' }))).toBe(true)
    expect(isCurrentDevice(item({ reason: 'unreachable' }))).toBe(true)
    for (const reason of ['disabled', 'no_agent', 'agent_offline', 'no_poll', 'stale'] as const) {
      expect(isCurrentDevice(item({ reason })), reason).toBe(false)
    }
    expect(isCurrentDevice({ ...item({ reason: 'ok' }), stale: true })).toBe(false)
  })

  it('shows a response time only as the present value of a reachable device', () => {
    expect(responseText(item())).toBe('12 ms')
    expect(responseText(item({ reason: 'unreachable' }))).toBe('—')
    expect(responseText(item({ reason: 'stale', responseMs: 9 }))).toBe('—')
    expect(responseText(item({ reason: 'no_poll' }))).toBe('—')
  })
})

describe('deviceReasonSentence', () => {
  const say = (entry: ReturnType<typeof item>) => deviceReasonSentence(entry, NOW)
  it('says each situation in its own words', () => {
    expect(say(item({ reason: 'disabled' }))).toMatch(/switched off/)
    expect(say(item({ reason: 'no_agent', agent: 'none' }))).toBe(
      'No agent is assigned to poll this device.',
    )
    expect(say(item({ reason: 'agent_offline' }))).toMatch(/disabled or has stopped reporting/)
    expect(say(item({ reason: 'agent_offline', agent: 'unknown' }))).toMatch(/never reported/)
    expect(say(item({ reason: 'no_poll' }))).toBe('It has not been polled yet.')
    expect(say(item({ reason: 'ok' }))).toBe('The latest poll reached the device.')
  })

  it('says a stale poll is the last one and not the current state, with its age', () => {
    const text = say(item({ reason: 'stale' }))
    expect(text).toMatch(/2h old/)
    expect(text).toMatch(/not the current state/)
  })

  it('says why an unreachable device was not reached, in words', () => {
    expect(say(item({ reason: 'unreachable', error: 'timeout' }))).toBe(
      'The latest poll could not reach the device: timeout.',
    )
    expect(say(item({ reason: 'unreachable', error: 'auth_failure' }))).toMatch(
      /authentication failure/,
    )
    expect(say(item({ reason: 'unreachable', error: null }))).toBe(
      'The latest poll could not reach the device.',
    )
  })

  it('gives a poll error this build does not know as it came', () => {
    expect(pollErrorText('weird_thing')).toBe('weird_thing')
    expect(pollErrorText(null)).toBeNull()
    expect(pollErrorText('dns_failure')).toBe('DNS failure')
  })
})

describe('the plain facts', () => {
  it('writes the type, the version, the schedule and the last poll', () => {
    expect(DEVICE_TYPE_LABEL.firewall).toBe('Firewall')
    expect(snmpText(item())).toBe('SNMPv2c port 161')
    expect(pollScheduleText(item())).toBe('every 60 s, timeout 5 s, 2 retries')
    expect(polledAgo(item(), NOW)).toBe('20s ago')
    expect(polledAgo(item({ reason: 'no_poll' }), NOW)).toBe('never')
  })
})

describe('the interface counts never speak for the device', () => {
  it('writes the total and the interfaces that are down or unknown, never the healthy or admin-down ones', () => {
    expect(
      interfaceCountsText(item({ interfaces: { healthy: 20, idle: 3, warning: 2, unknown: 1 } })),
    ).toBe('26 · 2 down · 1 unknown')
    expect(interfaceCountsText(item({ interfaces: { healthy: 8 } }))).toBe('8')
  })

  it('speaks every state in full', () => {
    expect(
      interfaceCountsSpoken(item({ interfaces: { healthy: 20, idle: 3, warning: 2, unknown: 1 } })),
    ).toBe('26 interfaces, 20 up, 3 admin down, 2 down, 1 unknown')
    expect(interfaceCountsSpoken(item({ interfaces: {} }))).toBe('no interfaces')
  })
})

describe('interfaces', () => {
  const words: Record<InterfaceReason, string> = {
    up: 'UP',
    down: 'DOWN',
    admin_down: 'ADMIN DOWN',
    device_unavailable: 'DEVICE N/A',
    absent: 'ABSENT',
    other: 'UNKNOWN',
  }
  it.each(Object.entries(words) as [InterfaceReason, string][])('%s reads %s', (reason, word) => {
    expect(interfaceReasonWord(reason)).toBe(word)
  })

  it('tells admin down, operationally down, up, unknown and device unavailable apart in words', () => {
    expect(interfaceReasonSentence(iface(1, 'admin_down'))).toBe(
      'Switched off on purpose (administratively down).',
    )
    expect(interfaceReasonSentence(iface(1, 'down'))).toBe(
      'Administratively up but operationally down.',
    )
    expect(interfaceReasonSentence(iface(1, 'down', { operStatus: 'lowerLayerDown' }))).toBe(
      'Administratively up but operationally lowerLayerDown.',
    )
    expect(interfaceReasonSentence(iface(1, 'up'))).toBe('Administratively and operationally up.')
    expect(interfaceReasonSentence(iface(1, 'other'))).toMatch(
      /Admin status up, operational status dormant: neither a clear up nor a clear down/,
    )
    expect(interfaceReasonSentence(iface(1, 'device_unavailable'))).toMatch(
      /last one stored, not the present one/,
    )
    expect(interfaceReasonSentence(iface(1, 'absent'))).toMatch(
      /not in the device’s latest complete interface listing/,
    )
  })

  it('names the IF-MIB words exactly as reported, and the alias beside the name', () => {
    expect(interfaceStateText(iface(1, 'down'))).toBe('admin up · oper down')
    expect(interfaceTitle(iface(7))).toBe('Gi1/0/7')
    expect(interfaceTitle(iface(7, 'up', { alias: 'uplink to core' }))).toBe(
      'Gi1/0/7 (uplink to core)',
    )
  })

  it('writes the speed, or a dash when the device reports none', () => {
    expect(speedText(iface(1))).toBe('1 Gbps')
    expect(speedText(iface(1, 'up', { speedBps: null }))).toBe('—')
  })
})

describe('rates', () => {
  const pick = {
    inBps: (r: ReturnType<typeof rates>) => r.inBps,
    util: (r: ReturnType<typeof rates>) => r.inUtilizationPercent,
    err: (r: ReturnType<typeof rates>) => r.outErrorsPerSec,
  }

  it('writes a valid rate in its unit', () => {
    const entry = iface(1)
    expect(rateText(entry, pick.inBps, 'bps')).toEqual({ text: '420.0 Mbps' })
    expect(rateText(entry, pick.util, 'percent')).toEqual({ text: '42.0%' })
    expect(rateText(entry, pick.err, 'perSecond')).toEqual({ text: '0.05/s' })
  })

  it('writes a valid zero as 0, because it is a measurement', () => {
    const entry = iface(1, 'up', { rates: rates({ inBps: 0, outErrorsPerSec: 0 }) })
    expect(rateText(entry, pick.inBps, 'bps')).toEqual({ text: '0 bps' })
    expect(rateText(entry, pick.err, 'perSecond')).toEqual({ text: '0.00/s' })
  })

  it('never writes an invalid rate as zero: a dash and the reason', () => {
    for (const [reason, state, fragment] of [
      ['delta_state', 'first', /first sample/],
      ['delta_state', 'reboot', /device restarted/],
      ['delta_state', 'reset', /counter was reset/],
      ['delta_state', 'gap', /previous sample was too old/],
      ['interval', 'ok', /no valid time interval/],
      ['implausible', 'ok', /1\.5 times the interface speed/],
      ['stale', 'ok', /older than the device’s stale limit/],
    ] as const) {
      const entry = iface(1, 'up', { rates: noRates(reason, state) })
      const cell = rateText(entry, pick.inBps, 'bps')
      expect(cell.text, reason).toBe('—')
      expect(cell.note, reason).toMatch(/^No rate: /)
      expect(cell.note, reason).toMatch(fragment)
      expect(rateText(entry, pick.err, 'perSecond').text).toBe('—')
    }
  })

  it('says an interface never sampled has no rate yet', () => {
    expect(rateText(iface(1, 'up', { rates: null }), pick.inBps, 'bps')).toEqual({
      text: '—',
      note: 'This interface has not been sampled yet.',
    })
  })

  it('shows the bps and says utilization is unavailable when the speed is unknown', () => {
    const entry = iface(1, 'up', {
      speedBps: null,
      rates: rates({ inUtilizationPercent: null, outUtilizationPercent: null }),
    })
    expect(rateText(entry, pick.inBps, 'bps').text).toBe('420.0 Mbps')
    expect(rateText(entry, pick.util, 'percent')).toEqual({
      text: '—',
      note: 'The interface speed is not known, so utilization cannot be given; the bits per second stand.',
    })
  })

  it('says a counter the device lacks is not reported, apart from an unknown speed', () => {
    const entry = iface(1, 'up', { rates: rates({ outErrorsPerSec: null }) })
    expect(rateText(entry, pick.err, 'perSecond')).toEqual({
      text: '—',
      note: 'The device does not report this counter.',
    })
  })

  it('has no invalid sentence for a rate that is valid', () => {
    expect(invalidSentence(rates())).toBeNull()
    expect(invalidSentence(noRates('interval'))).toBe(
      'No rate: the sample has no valid time interval.',
    )
  })

  it('dates nothing by itself: the sample time is the API’s', () => {
    expect(iso(0)).toBe(new Date(NOW).toISOString())
  })
})
