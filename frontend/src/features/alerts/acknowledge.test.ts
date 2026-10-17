import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { describeAcknowledged, describeFailure } from './acknowledge'
import { detail, incident } from './testing'

describe('what a failed acknowledgement says', () => {
  it('says a 403 is the account’s permission', () => {
    expect(describeFailure(new ApiError('x', 403, 'forbidden'))).toBe(
      'You may not acknowledge incidents: your account lacks the permission.',
    )
  })

  it('says a 404 is an incident that is gone or hidden, and that nothing was acknowledged', () => {
    expect(describeFailure(new ApiError('x', 404, 'not_found'))).toMatch(
      /no longer exists, or you may no longer see it\. Nothing was acknowledged\./,
    )
  })

  it('says a 409 is an incident that already ended', () => {
    expect(describeFailure(new ApiError('x', 409, 'incident_ended'))).toBe(
      'This incident has already ended, so there is nothing to acknowledge.',
    )
  })

  it.each(['network', 'timeout'])(
    'says it is not known whether it went through after a %s failure',
    (code) => {
      expect(describeFailure(new ApiError('x', null, code))).toMatch(
        /not known whether the incident was acknowledged. Reload to check/,
      )
    },
  )

  it('quotes the server’s message for any other refusal, and is plain for a failure that is no API answer', () => {
    expect(describeFailure(new ApiError('The server could not complete the request.', 500))).toBe(
      'The incident could not be acknowledged: The server could not complete the request.',
    )
    expect(describeFailure(new TypeError('boom'))).toBe('The incident could not be acknowledged.')
  })
})

describe('what an acknowledgement answers', () => {
  const me = { username: 'ana', displayName: 'Ana' }
  const answer = (by: string | null, status: 'acknowledged' | 'active' = 'acknowledged') =>
    detail(incident({ status, acknowledgedBy: by }))

  it('says this user acknowledged it, and that it stays open', () => {
    expect(describeAcknowledged(answer('ana'), me)).toBe(
      'Acknowledged by ana. It stays open until the condition clears.',
    )
    expect(describeAcknowledged(answer('Ana'), me)).toMatch(/^Acknowledged by Ana\./)
  })

  it('says someone else did it first, and that it is still open', () => {
    expect(describeAcknowledged(answer('first'), me)).toBe(
      'Already acknowledged by first. It is still open.',
    )
  })

  it('says only who acknowledged it where it is not known who is signed in', () => {
    expect(describeAcknowledged(answer('first'), null)).toMatch(/^Acknowledged by first\./)
  })

  it('says no name where the API recorded none', () => {
    expect(describeAcknowledged(answer(null), me)).toBe(
      'Acknowledged. It stays open until the condition clears.',
    )
  })

  it('does not call an answer that is still active an acknowledgement', () => {
    expect(describeAcknowledged(answer(null, 'active'), me)).toMatch(/not recorded/)
  })
})
