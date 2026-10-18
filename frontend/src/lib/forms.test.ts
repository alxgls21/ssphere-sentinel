import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { describeWriteFailure } from './forms'

const invalid = (fields: Record<string, string[]>) =>
  new ApiError('Invalid request.', 400, 'validation_error', { fields })

describe('describeWriteFailure', () => {
  it('puts the server’s words under the fields the form shows', () => {
    const failure = describeWriteFailure(invalid({ name: ['Taken.'], severity: ['Bad.'] }), [
      'name',
      'severity',
    ])
    expect(failure.fields).toEqual({ name: ['Taken.'], severity: ['Bad.'] })
    expect(failure.general).toEqual([])
    expect(failure.message).toBeNull()
    expect(failure.status).toBe(400)
    expect(failure.code).toBe('validation_error')
  })

  it('lists a problem of the whole as it came, and one of a field not shown with its name', () => {
    const failure = describeWriteFailure(
      invalid({ nonField: ['Not this combination.'], customerId: ['No such customer.'] }),
      ['name'],
    )
    expect(failure.general).toEqual(['Not this combination.', 'customerId: No such customer.'])
    expect(failure.fields).toEqual({})
  })

  it('loses no problem: every field is either shown or listed', () => {
    const failure = describeWriteFailure(invalid({ name: ['a'], other: ['b'], nonField: ['c'] }), [
      'name',
    ])
    expect(Object.values(failure.fields).flat().length + failure.general.length).toBe(3)
  })

  it.each([
    ['network', null, /could not be reached/],
    ['timeout', null, /could not be reached/],
  ])('says there was no answer for a %s failure, without the internals', (code, status, words) => {
    const failure = describeWriteFailure(new ApiError('Cannot reach the server.', status, code), [])
    expect(failure.message).toMatch(words)
    expect(failure.message).not.toMatch(/Cannot reach the server/)
    expect(failure.status).toBeNull()
  })

  it('says a refused change is refused, and a vanished object is gone', () => {
    expect(describeWriteFailure(new ApiError('Forbidden.', 403, 'forbidden'), []).message).toBe(
      'This account may not make this change.',
    )
    expect(describeWriteFailure(new ApiError('Not found.', 404, 'not_found'), []).message).toBe(
      'It no longer exists, or you may no longer see it.',
    )
  })

  it('keeps the server’s own sentence for a conflict, and the code to tell which', () => {
    const failure = describeWriteFailure(
      new ApiError('The rule changed.', 409, 'version_conflict'),
      [],
    )
    expect(failure).toMatchObject({
      status: 409,
      code: 'version_conflict',
      message: 'The rule changed.',
    })
  })

  it('says only that it could not be saved for anything that is not an API answer', () => {
    const failure = describeWriteFailure(new TypeError('x is undefined at /srv/app/app.js'), [])
    expect(failure).toEqual({
      fields: {},
      general: [],
      status: null,
      code: null,
      message: 'The change could not be saved.',
    })
  })
})
