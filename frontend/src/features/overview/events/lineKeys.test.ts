import { describe, expect, it } from 'vitest'
import { lineTarget } from './lineKeys'

describe('lineTarget', () => {
  it('moves one line with the arrow keys and stops at the ends', () => {
    expect(lineTarget('ArrowDown', 1, 4)).toBe(2)
    expect(lineTarget('ArrowDown', 4, 4)).toBe(4)
    expect(lineTarget('ArrowUp', 1, 4)).toBe(0)
    expect(lineTarget('ArrowUp', 0, 4)).toBe(0)
  })

  it('jumps to the first and the last line with Home and End', () => {
    expect(lineTarget('Home', 3, 4)).toBe(0)
    expect(lineTarget('End', 1, 4)).toBe(4)
  })

  it('has nowhere to go for any other key', () => {
    expect(lineTarget('ArrowLeft', 1, 4)).toBeNull()
    expect(lineTarget('a', 1, 4)).toBeNull()
    expect(lineTarget('Enter', 1, 4)).toBeNull()
  })
})
