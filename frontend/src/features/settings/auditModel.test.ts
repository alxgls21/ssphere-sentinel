import { describe, expect, it } from 'vitest'
import {
  auditRequest,
  changeLines,
  isDefaultAuditView,
  parseAuditQuery,
  valueText,
  writeAuditQuery,
} from './auditModel'

describe('the audit log query', () => {
  it('reads the filters from the URL, keeping only what looks like one of the API’s keys', () => {
    expect(
      parseAuditQuery(new URLSearchParams('q=maria&action=user_created&targetType=user&page=2')),
    ).toEqual({
      q: 'maria',
      action: 'user_created',
      targetType: 'user',
      page: 2,
    })
    expect(parseAuditQuery(new URLSearchParams('action=DROP%20TABLE&targetType=x-y'))).toEqual({
      q: '',
      action: '',
      targetType: '',
      page: 1,
    })
  })

  it('writes only what narrows, and asks the API with the settled search', () => {
    const query = { q: 'm', action: 'user_created', targetType: '', page: 3 }
    expect(Object.fromEntries(writeAuditQuery(new URLSearchParams('range=6h'), query))).toEqual({
      range: '6h',
      q: 'm',
      action: 'user_created',
      page: '3',
    })
    expect(auditRequest(query, 'settled')).toEqual({
      q: 'settled',
      action: 'user_created',
      targetType: '',
      page: 3,
      pageSize: 50,
    })
    expect(isDefaultAuditView(query)).toBe(false)
    expect(isDefaultAuditView({ q: ' ', action: '', targetType: '', page: 5 })).toBe(true)
  })
})

describe('a recorded change, in words', () => {
  it('says nothing, yes, no, blank, a list or the value', () => {
    expect(valueText(null)).toBe('none')
    expect(valueText(true)).toBe('yes')
    expect(valueText(false)).toBe('no')
    expect(valueText('')).toBe('blank')
    expect(valueText([])).toBe('none')
    expect(valueText(['a', 1, null])).toBe('a, 1, none')
    expect(valueText(99.5)).toBe('99.5')
  })

  it('lists the changes in the order recorded', () => {
    expect(
      changeLines({
        name: { before: 'Old', after: 'New' },
        enabled: { before: true, after: false },
      }),
    ).toEqual([
      { field: 'name', before: 'Old', after: 'New' },
      { field: 'enabled', before: 'yes', after: 'no' },
    ])
  })
})
