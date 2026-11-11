import { describe, expect, it } from 'vitest'
import { EMPTY_DRAFT, hasErrors, siteChoices, toInput, validate } from './serverDraft'

const draft = (over: Partial<typeof EMPTY_DRAFT> = {}) => ({ ...EMPTY_DRAFT, ...over })

describe('validate', () => {
  it('needs a name and nothing else', () => {
    expect(validate(EMPTY_DRAFT)).toEqual({ name: ['Required.'] })
    expect(validate(draft({ name: '   ' }))).toEqual({ name: ['Required.'] })
    expect(validate(draft({ name: 'web-1' }))).toEqual({})
    expect(hasErrors(validate(draft({ name: 'web-1' })))).toBe(false)
  })

  it('says a value is too long before the server has to', () => {
    expect(validate(draft({ name: 'n'.repeat(256) })).name).toEqual(['At most 255 characters.'])
    expect(validate(draft({ name: 'x', hostname: 'h'.repeat(256) })).hostname).toEqual([
      'At most 255 characters.',
    ])
    expect(
      validate(draft({ name: 'x', operatingSystem: 'o'.repeat(256) })).operatingSystem,
    ).toEqual(['At most 255 characters.'])
    expect(validate(draft({ name: 'x', description: 'd'.repeat(2001) })).description).toEqual([
      'At most 2000 characters.',
    ])
    expect(hasErrors(validate(draft({ name: 'x', description: 'd'.repeat(2000) })))).toBe(false)
  })

  it('refuses a host name where an address is expected, and accepts addresses of both families', () => {
    expect(validate(draft({ name: 'x', ipAddress: 'web.example.com' })).ipAddress).toEqual([
      'Expected an IPv4 or IPv6 address.',
    ])
    expect(validate(draft({ name: 'x', ipAddress: '10.0.0.5 ' })).ipAddress).toBeUndefined()
    expect(validate(draft({ name: 'x', ipAddress: '2001:db8::1' })).ipAddress).toBeUndefined()
    expect(validate(draft({ name: 'x', ipAddress: '' })).ipAddress).toBeUndefined()
  })
})

describe('toInput', () => {
  it('sends the name alone when nothing else was typed, with no address and no site', () => {
    expect(toInput(draft({ name: ' web-1 ' }))).toEqual({
      name: 'web-1',
      ipAddress: null,
      siteId: null,
    })
  })

  it('sends what was typed, trimmed, and leaves a blank hostname to the server', () => {
    expect(
      toInput(
        draft({
          name: 'web-1',
          hostname: ' web-1.example.net ',
          siteId: 's1',
          ipAddress: ' 10.0.0.5 ',
          operatingSystem: ' Debian 12 ',
          description: 'front',
        }),
      ),
    ).toEqual({
      name: 'web-1',
      hostname: 'web-1.example.net',
      operatingSystem: 'Debian 12',
      description: 'front',
      ipAddress: '10.0.0.5',
      siteId: 's1',
    })
  })
})

describe('siteChoices', () => {
  it('offers no site first, then every site named with its customer', () => {
    expect(
      siteChoices({
        customers: [{ id: 'c1', name: 'Meridian' }],
        sites: [
          { id: 's1', customerId: 'c1', name: 'Athens DC' },
          { id: 's2', customerId: 'c9', name: 'Orphan' },
        ],
      }),
    ).toEqual([
      { value: '', label: 'No site (seen by accounts with every customer only)' },
      { value: 's1', label: 'Meridian / Athens DC' },
      { value: 's2', label: 'Unknown customer / Orphan' },
    ])
  })
})
