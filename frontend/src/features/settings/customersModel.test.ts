import { describe, expect, it } from 'vitest'
import type { CustomerRecord, SiteRecord } from '@/api/types'
import {
  customerDraft,
  customerInput,
  customerPatch,
  newSiteDraft,
  siteDraft,
  siteInput,
  sitePatch,
  validateCustomer,
  validateSite,
} from './customersModel'

const customer: CustomerRecord = {
  id: 'c1',
  name: 'Meridian',
  notes: 'first',
  sites: 1,
  servers: 0,
  devices: 0,
  targets: 0,
  domains: 0,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
}
const site: SiteRecord = {
  id: 's1',
  customerId: 'c1',
  customerName: 'Meridian',
  name: 'Athens DC',
  description: '',
  servers: 0,
  devices: 0,
  targets: 0,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
}

describe('the customer form', () => {
  it('requires a name within its length, and bounds the notes', () => {
    expect(validateCustomer({ name: '  ', notes: '' })).toEqual({ name: ['Required.'] })
    expect(validateCustomer({ name: 'a'.repeat(256), notes: '' })).toEqual({
      name: ['At most 255 characters.'],
    })
    expect(validateCustomer({ name: 'M', notes: 'n'.repeat(2001) })).toEqual({
      notes: ['At most 2000 characters.'],
    })
    expect(validateCustomer({ name: 'M', notes: 'ok' })).toEqual({})
  })

  it('sends the name trimmed and the notes as typed', () => {
    expect(customerInput({ name: ' Meridian ', notes: 'line\nline' })).toEqual({
      name: 'Meridian',
      notes: 'line\nline',
    })
  })

  it('sends only what changed, and nothing when nothing did', () => {
    expect(customerPatch(customerDraft(customer), customer)).toBeNull()
    expect(customerPatch({ name: 'Meridian', notes: 'second' }, customer)).toEqual({
      notes: 'second',
    })
    expect(customerPatch({ name: ' Meridian Ltd ', notes: 'first' }, customer)).toEqual({
      name: 'Meridian Ltd',
    })
  })
})

describe('the site form', () => {
  it('starts with the customer it was opened for', () => {
    expect(newSiteDraft('c1')).toEqual({ customerId: 'c1', name: '', description: '' })
    expect(newSiteDraft()).toEqual({ customerId: '', name: '', description: '' })
  })

  it('requires a customer and a name', () => {
    expect(validateSite({ customerId: '', name: '', description: '' })).toEqual({
      customerId: ['Choose the customer the site belongs to.'],
      name: ['Required.'],
    })
    expect(validateSite(siteDraft(site))).toEqual({})
  })

  it('sends only what changed, a move included', () => {
    expect(sitePatch(siteDraft(site), site)).toBeNull()
    expect(sitePatch({ customerId: 'c2', name: 'Athens DC', description: '' }, site)).toEqual({
      customerId: 'c2',
    })
    expect(siteInput({ customerId: 'c1', name: ' Plant ', description: 'd' })).toEqual({
      customerId: 'c1',
      name: 'Plant',
      description: 'd',
    })
  })
})
