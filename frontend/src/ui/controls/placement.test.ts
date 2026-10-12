import { describe, expect, it } from 'vitest'
import { placeMenu, placeTooltip, type Anchor } from './placement'

const viewport = { width: 1000, height: 700 }

const anchor = (left: number, top: number, width = 40, height = 28): Anchor => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})

describe('placeTooltip', () => {
  it('centers above the trigger', () => {
    const spot = placeTooltip(anchor(400, 300), { width: 100, height: 20 }, viewport)
    expect(spot).toEqual({ left: 370, top: 274 })
  })

  it('flips below when there is no room above', () => {
    const spot = placeTooltip(anchor(400, 10), { width: 100, height: 20 }, viewport)
    expect(spot.top).toBe(10 + 28 + 6)
  })

  it('stays above when there is no room above but even less below', () => {
    const spot = placeTooltip(
      anchor(400, 40),
      { width: 100, height: 60 },
      { width: 1000, height: 90 },
    )
    expect(spot.top).toBe(8)
  })

  it('is kept inside the viewport horizontally', () => {
    const size = { width: 120, height: 20 }
    expect(placeTooltip(anchor(0, 300, 16), size, viewport).left).toBe(8)
    expect(placeTooltip(anchor(990, 300, 8), size, viewport).left).toBe(1000 - 120 - 8)
  })
})

describe('placeMenu', () => {
  it('opens below the trigger with the right edges aligned', () => {
    const spot = placeMenu(anchor(900, 8, 60), { width: 200, height: 150 }, viewport)
    expect(spot.left).toBe(760)
    expect(spot.top).toBe(8 + 28 + 4)
  })

  it('never starts left of the viewport edge margin', () => {
    expect(placeMenu(anchor(10, 8), { width: 200, height: 150 }, viewport).left).toBe(8)
  })

  it('caps its height to the room below the trigger', () => {
    const spot = placeMenu(anchor(900, 600), { width: 200, height: 400 }, viewport)
    expect(spot.maxHeight).toBe(700 - (600 + 28 + 4) - 8)
  })
})
