import { describe, expect, it } from 'vitest'
import { recallRow, rememberRow } from './returnFocus'

describe('returnFocus', () => {
  it('reads back the row it stored', () => {
    expect(recallRow(rememberRow(null, 'server:srv-1'))).toBe('server:srv-1')
  })

  it('keeps whatever else the history entry carries', () => {
    expect(rememberRow({ from: 'palette' }, 'target:t1')).toEqual({
      from: 'palette',
      attentionRow: 'target:t1',
    })
  })

  it('finds nothing in an entry that never opened a row', () => {
    expect(recallRow(null)).toBeUndefined()
    expect(recallRow(undefined)).toBeUndefined()
    expect(recallRow('text')).toBeUndefined()
    expect(recallRow({ attentionRow: 42 })).toBeUndefined()
  })
})
