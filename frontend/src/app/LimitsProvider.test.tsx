import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PublishedThresholds } from '@/api/auth'
import { limitsOrigin, useResourceLimits } from '@/ui/meters'
import { createFakeAuth } from '@/test/render'
import { AuthContext } from './auth/auth'
import { LimitsProvider } from './LimitsProvider'

const published = (over: Partial<PublishedThresholds> = {}): PublishedThresholds => ({
  resourceWarnPercent: 70,
  resourceCritPercent: 90,
  probeLossWarnPercent: 2,
  probeLatencyWarnMs: 150,
  targetCritFailures: 3,
  ...over,
})

function Reading() {
  const limits = useResourceLimits()
  return (
    <output>
      {limits.warn}/{limits.crit} {limitsOrigin(limits)}
    </output>
  )
}

const shown = (thresholds: PublishedThresholds | null) => {
  render(
    <AuthContext.Provider value={createFakeAuth({ thresholds })}>
      <LimitsProvider>
        <Reading />
      </LimitsProvider>
    </AuthContext.Provider>,
  )
  return screen.getByRole('status').textContent
}

describe('LimitsProvider', () => {
  it('puts the limits the server published in force, and says whose they are', () => {
    expect(shown(published())).toBe('70/90 set on the server')
  })

  it('keeps the console defaults when the session published none (mock mode, signed out)', () => {
    expect(shown(null)).toBe('80/95 UI defaults')
  })

  it.each([
    ['warn not below critical', { resourceWarnPercent: 90, resourceCritPercent: 90 }],
    ['warn above critical', { resourceWarnPercent: 96, resourceCritPercent: 90 }],
    ['a critical limit above 100', { resourceCritPercent: 120 }],
    ['a negative warn limit', { resourceWarnPercent: -5 }],
  ])('does not use limits that make no sense (%s)', (_what, over) => {
    expect(shown(published(over))).toBe('80/95 UI defaults')
  })
})
