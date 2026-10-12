import { describe, expect, it } from 'vitest'
import { nextPollText } from './nextPoll'

const base = {
  paused: false,
  fetching: false,
  pollMs: 15_000,
  lastUpdatedAt: 100_000,
  now: 103_000,
}

describe('nextPollText', () => {
  it('counts down to the next poll', () => {
    expect(nextPollText(base)).toBe('next poll 12s')
    expect(nextPollText({ ...base, now: 114_100 })).toBe('next poll 1s')
  })

  it('rounds up, so it never claims 0s before the poll is due', () => {
    expect(nextPollText({ ...base, now: 114_999 })).toBe('next poll 1s')
    expect(nextPollText({ ...base, now: 115_000 })).toBe('next poll 0s')
  })

  it('stays at 0s when the poll is overdue instead of going negative', () => {
    expect(nextPollText({ ...base, now: 150_000 })).toBe('next poll 0s')
  })

  it('says PAUSED while frozen, whatever the clock says', () => {
    expect(nextPollText({ ...base, paused: true })).toBe('PAUSED')
  })

  it('says updating while a request is in flight', () => {
    expect(nextPollText({ ...base, fetching: true })).toBe('updating')
  })

  it('has no countdown before the first load', () => {
    expect(nextPollText({ ...base, lastUpdatedAt: null })).toBe('next poll —')
  })
})
