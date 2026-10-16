import { describe, expect, it } from 'vitest'
import { buildTooltipElement } from './tooltip'

const HOSTILE = '<img src=x onerror="alert(1)">edge-gw-02'

describe('buildTooltipElement', () => {
  const node = buildTooltipElement({
    title: '13:41Z',
    rows: [
      { key: 'line', color: 'var(--color-primary)', value: '142 ms', label: 'p95' },
      { key: 'rect', color: 'var(--color-series-2)', value: '2.1%', label: 'loss' },
    ],
  })

  it('leads each row with its value and follows with the series name', () => {
    const cells = [...node.querySelectorAll('.grid > span')].map((cell) => cell.textContent)
    // Per row: key swatch (empty), value, label.
    expect(cells).toEqual(['', '142 ms', 'p95', '', '2.1%', 'loss'])
  })

  it('shows the timestamp first', () => {
    expect(node.firstElementChild?.textContent).toBe('13:41Z')
  })

  it('keys each row with the series color, as a mark and never as text', () => {
    const keys = node.querySelectorAll<HTMLElement>('.grid > span:nth-child(3n+1)')
    expect([...keys].map((key) => key.style.backgroundColor)).toEqual([
      'var(--color-primary)',
      'var(--color-series-2)',
    ])
    // Only the two swatches carry a color: values and labels stay in text tokens.
    expect(node.querySelectorAll('[style]')).toHaveLength(2)
  })

  it('treats names as text: untrusted data never becomes markup', () => {
    const hostile = buildTooltipElement({
      title: HOSTILE,
      rows: [{ key: 'line', color: 'var(--color-primary)', value: HOSTILE, label: HOSTILE }],
    })
    expect(hostile.querySelector('img')).toBeNull()
    expect(hostile.textContent).toContain(HOSTILE)
    expect(hostile.innerHTML).not.toContain('<img')
  })

  it('adds no line to a row that has passed no limit', () => {
    expect(node.querySelectorAll('.grid > span')).toHaveLength(6)
  })
})

describe('buildTooltipElement flag', () => {
  const flagged = buildTooltipElement({
    title: '13:39Z',
    rows: [
      {
        key: 'line',
        color: 'var(--color-primary)',
        value: '212 ms',
        label: 'p95',
        flag: '62 ms over warn',
      },
      { key: 'line', color: 'var(--color-series-other)', value: '90 ms', label: 'p50' },
      {
        key: 'rect',
        color: 'var(--color-series-2)',
        value: '2.5%',
        label: 'loss',
        flag: '0.5% over warn',
      },
    ],
  })

  it('says the state in words on a line under its row, in the value and label columns', () => {
    const cells = [...flagged.querySelectorAll('.grid > span')].map((cell) => cell.textContent)
    expect(cells).toEqual([
      '',
      '212 ms',
      'p95',
      '',
      '62 ms over warn',
      '',
      '90 ms',
      'p50',
      '',
      '2.5%',
      'loss',
      '',
      '0.5% over warn',
    ])
    const sentence = flagged.querySelector('.grid > span:nth-child(5)')
    expect(sentence).toHaveClass('col-span-2')
  })

  it('marks the state with a warning triangle, a shape, so it never rests on color', () => {
    const triangle = flagged.querySelector('.grid > span:nth-child(4)')
    expect(triangle).toHaveClass('bg-warning')
    expect(triangle?.className).toContain('clip-path:polygon(50%_0,100%_100%,0_100%)')
    expect(triangle?.textContent).toBe('')
  })

  it('draws the triangle for the flagged rows only', () => {
    expect(flagged.querySelectorAll('.bg-warning')).toHaveLength(2)
  })

  it('keeps the colors in classes and the series colors in the swatches alone', () => {
    expect(flagged.querySelectorAll('[style]')).toHaveLength(3)
  })

  it('treats a flag as text: untrusted data never becomes markup', () => {
    const hostile = buildTooltipElement({
      title: '13:39Z',
      rows: [{ key: 'line', color: 'red', value: '1', label: 'p95', flag: HOSTILE }],
    })
    expect(hostile.querySelector('img')).toBeNull()
    expect(hostile.textContent).toContain(HOSTILE)
  })
})
