import { describe, expect, it } from 'vitest'
import { copyText as shared } from '@/lib/clipboard'
import { copyText } from './clipboard'

describe('the palette’s clipboard', () => {
  it('is the shared helper (its behavior is tested in lib/clipboard.test.ts)', () => {
    expect(copyText).toBe(shared)
  })
})
