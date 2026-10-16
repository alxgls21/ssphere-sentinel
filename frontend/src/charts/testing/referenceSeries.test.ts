import { describe, expect, it } from 'vitest'
import { REFERENCE_SERIES_PREFIX } from '../timeSeries'
import { isReferenceSeries } from './referenceSeries'

describe('isReferenceSeries', () => {
  it('tells a reference series from a data series by its id', () => {
    expect(isReferenceSeries({ id: `${REFERENCE_SERIES_PREFIX}latency` })).toBe(true)
    expect(isReferenceSeries({ id: 'p95' })).toBe(false)
    expect(isReferenceSeries({})).toBe(false)
    expect(isReferenceSeries({ id: 3 })).toBe(false)
  })
})
