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
})
