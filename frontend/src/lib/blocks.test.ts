import { describe, expect, it } from 'vitest'
import type { StatusCounts } from '@/api/types'
import {
  blockBar,
  blockMeter,
  describeCounts,
  filledCells,
  nonZeroCounts,
  spokenStatus,
} from './blocks'

const counts = (partial: Partial<StatusCounts>): StatusCounts => ({
  healthy: 0,
  warning: 0,
  critical: 0,
  unknown: 0,
  idle: 0,
  ...partial,
})

const run = (text: string, char: string) => [...text].filter((c) => c === char).length

describe('nonZeroCounts', () => {
  it('lists present statuses worst first: critical, warning, unknown, idle, healthy', () => {
    const result = nonZeroCounts(
      counts({ healthy: 9, idle: 1, unknown: 2, warning: 3, critical: 4 }),
    )
    expect(result.map((entry) => entry.status)).toEqual([
      'critical',
      'warning',
      'unknown',
      'idle',
      'healthy',
    ])
    expect(result.map((entry) => entry.count)).toEqual([4, 3, 2, 1, 9])
  })

  it('drops statuses with a zero count', () => {
    expect(nonZeroCounts(counts({ healthy: 3 }))).toEqual([{ status: 'healthy', count: 3 }])
    expect(nonZeroCounts(counts({}))).toEqual([])
  })
})

describe('describeCounts', () => {
  it('speaks every non-zero count, worst first', () => {
    expect(describeCounts(counts({ healthy: 13, warning: 2, critical: 1 }))).toBe(
      '1 critical, 2 warning, 13 ok',
    )
    expect(describeCounts(counts({ idle: 3, unknown: 1, healthy: 1 }))).toBe(
      '1 unknown, 3 idle, 1 ok',
    )
  })

  it('says "none" when nothing is counted', () => {
    expect(describeCounts(counts({}))).toBe('none')
  })

  it('separates thousands like the rest of the console', () => {
    expect(describeCounts(counts({ healthy: 1234 }))).toBe('1,234 ok')
  })
})

describe('spokenStatus', () => {
  it('uses "ok" for healthy and the status name otherwise', () => {
    expect(spokenStatus('healthy')).toBe('ok')
    expect(spokenStatus('critical')).toBe('critical')
  })
})

describe('blockBar', () => {
  it('is 20 characters, worst first, with every non-zero status represented', () => {
    const bar = blockBar(counts({ critical: 1, warning: 2, healthy: 13 }))
    expect(bar).toHaveLength(20)
    // 1.25 / 2.5 / 16.25 cells: the warning share has the largest remainder.
    expect(bar).toBe('█▓▓▓' + '▁'.repeat(16))
  })

  it('orders all five statuses crit, warn, unknown, idle, ok', () => {
    const bar = blockBar(counts({ healthy: 10, idle: 4, unknown: 2, warning: 2, critical: 2 }))
    expect(bar).toHaveLength(20)
    expect(bar.replace(/(.)\1*/g, '$1')).toBe('█▓▒░▁')
  })

  it('keeps one cell for a lone failure in a large fleet (the 3px minimum, in text)', () => {
    const bar = blockBar(counts({ critical: 1, healthy: 123 }))
    expect(bar).toBe('█' + '▁'.repeat(19))
  })

  it('never exceeds the cell count when many minimums are claimed at once', () => {
    const bar = blockBar(counts({ critical: 1, warning: 1, unknown: 1, idle: 1, healthy: 1000 }))
    expect(bar).toHaveLength(20)
    expect(bar.replace(/(.)\1*/g, '$1')).toBe('█▓▒░▁')
    expect(run(bar, '█')).toBe(1)
  })

  it('is always exactly the requested length', () => {
    for (let healthy = 0; healthy <= 40; healthy += 1) {
      for (let critical = 0; critical <= 4; critical += 1) {
        for (const warning of [0, 1, 7]) {
          const total = healthy + critical + warning
          if (total === 0) continue
          const bar = blockBar(counts({ healthy, critical, warning }))
          expect(bar, `${healthy}/${critical}/${warning}`).toHaveLength(20)
        }
      }
    }
  })

  it('renders an all-quiet fleet as quiet blocks and an empty one as a dotted track', () => {
    expect(blockBar(counts({ healthy: 40 }))).toBe('▁'.repeat(20))
    expect(blockBar(counts({}))).toBe('·'.repeat(20))
  })

  it('honours a custom width, dropping the healthiest statuses when it is too small', () => {
    expect(blockBar(counts({ critical: 1, healthy: 1 }), 10)).toBe('█████▁▁▁▁▁')
    const narrow = blockBar(counts({ critical: 1, warning: 1, unknown: 1, healthy: 9 }), 2)
    expect(narrow).toBe('█▓')
    expect(blockBar(counts({ healthy: 5 }), 0)).toBe('')
  })
})

describe('filledCells', () => {
  it('lights a cell once the percentage is within half a cell of its upper bound', () => {
    expect(filledCells(0)).toBe(0)
    expect(filledCells(2.4)).toBe(0)
    expect(filledCells(2.5)).toBe(1)
    expect(filledCells(7.4)).toBe(1)
    expect(filledCells(7.5)).toBe(2)
    expect(filledCells(82)).toBe(16)
    expect(filledCells(91)).toBe(18)
    expect(filledCells(95)).toBe(19)
    expect(filledCells(97.5)).toBe(20)
    expect(filledCells(100)).toBe(20)
  })

  it('clamps out-of-range values and treats missing or non-finite samples as empty', () => {
    expect(filledCells(-5)).toBe(0)
    expect(filledCells(140)).toBe(20)
    expect(filledCells(null)).toBe(0)
    expect(filledCells(Number.NaN)).toBe(0)
  })

  it('scales to other cell counts', () => {
    expect(filledCells(50, 10)).toBe(5)
    expect(filledCells(44, 10)).toBe(4)
    expect(filledCells(45, 10)).toBe(5)
  })
})

describe('blockMeter', () => {
  it('draws filled blocks then empty ones, 20 in total', () => {
    expect(blockMeter(82)).toBe('█'.repeat(16) + '░'.repeat(4))
    expect(blockMeter(0)).toBe('░'.repeat(20))
    expect(blockMeter(100)).toBe('█'.repeat(20))
  })

  it('is all empty when there is no sample', () => {
    expect(blockMeter(null)).toBe('░'.repeat(20))
  })

  it('honours a custom cell count', () => {
    expect(blockMeter(50, 10)).toBe('█████░░░░░')
  })
})

describe('offline in the text twins', () => {
  it('lists offline apart from the critical it is part of, directly after it', () => {
    const result = nonZeroCounts(
      counts({ healthy: 9, idle: 1, unknown: 2, warning: 3, critical: 4, offline: 1 }),
    )
    expect(result).toEqual([
      { status: 'critical', count: 3 },
      { status: 'offline', count: 1 },
      { status: 'warning', count: 3 },
      { status: 'unknown', count: 2 },
      { status: 'idle', count: 1 },
      { status: 'healthy', count: 9 },
    ])
  })

  it('drops the critical entry when every critical member is offline', () => {
    expect(nonZeroCounts(counts({ critical: 2, offline: 2, healthy: 1 }))).toEqual([
      { status: 'offline', count: 2 },
      { status: 'healthy', count: 1 },
    ])
  })

  it('speaks "1 critical, 1 offline" and keeps the totals', () => {
    const spoken = describeCounts(counts({ healthy: 13, warning: 2, critical: 2, offline: 1 }))
    expect(spoken).toBe('1 critical, 1 offline, 2 warning, 13 ok')
    expect(describeCounts(counts({ critical: 1, offline: 1 }))).toBe('1 offline')
  })

  it('names the status the way ui/status does', () => {
    expect(spokenStatus('offline')).toBe('offline')
  })

  it('draws offline with a character of its own, between critical and warning', () => {
    const bar = blockBar(
      counts({ healthy: 10, idle: 2, unknown: 2, warning: 2, critical: 4, offline: 2 }),
    )
    expect(bar).toHaveLength(20)
    expect(bar.replace(/(.)\1*/g, '$1')).toBe('█▞▓▒░▁')
    const characters = ['█', '▞', '▓', '▒', '░', '▁']
    expect(new Set(characters).size).toBe(characters.length)
  })

  it('keeps one cell for a lone offline server in a large fleet', () => {
    const bar = blockBar(counts({ critical: 1, offline: 1, healthy: 123 }))
    expect(bar).toBe('▞' + '▁'.repeat(19))
  })

  it('stays exactly the requested length however the cells are shared', () => {
    for (let healthy = 0; healthy <= 30; healthy += 3) {
      for (const offline of [0, 1, 2]) {
        const total = healthy + 2 + offline
        const bar = blockBar(counts({ healthy, critical: 2 + offline, offline, warning: 1 }), 20)
        expect(bar, `${healthy}/${offline} of ${total}`).toHaveLength(20)
      }
    }
  })
})
