import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  draftFromServer,
  hasErrors,
  siteChoices,
  toInput,
  toPatch,
  validate,
} from './serverDraft'

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

describe('a change of a server', () => {
  const server = {
    id: 'srv-1',
    name: 'web-1',
    hostname: 'web-1.example.net',
    ipAddress: '10.0.0.5',
    operatingSystem: 'Debian 12',
    description: 'front',
    status: 'online' as const,
    siteId: 's1',
    lastSeenAt: null,
    agentVersion: '',
    telemetry: null,
  }

  it('starts from the server as it is', () => {
    expect(draftFromServer(server)).toEqual({
      name: 'web-1',
      hostname: 'web-1.example.net',
      siteId: 's1',
      ipAddress: '10.0.0.5',
      operatingSystem: 'Debian 12',
      description: 'front',
    })
    expect(
      draftFromServer({ ...server, siteId: null, ipAddress: null, description: undefined }),
    ).toMatchObject({ siteId: '', ipAddress: '', description: '' })
  })

  it('sends only what changed, nothings as null, and nothing when nothing did', () => {
    expect(toPatch(draftFromServer(server), server)).toBeNull()
    expect(toPatch({ ...draftFromServer(server), name: ' web-01 ' }, server)).toEqual({
      name: 'web-01',
    })
    expect(toPatch({ ...draftFromServer(server), ipAddress: '', siteId: '' }, server)).toEqual({
      ipAddress: null,
      siteId: null,
    })
    expect(toPatch({ ...draftFromServer(server), hostname: '', description: '' }, server)).toEqual({
      hostname: '',
      description: '',
    })
  })
})
