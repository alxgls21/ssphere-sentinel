import { describe, expect, it } from 'vitest'
import {
  FILTERED_SIMULATIONS,
  SIMULATIONS,
  colorMatrixValues,
  filterId,
  visionFilter,
} from './vision'

const numbers = (simulation: Parameters<typeof colorMatrixValues>[0]) =>
  colorMatrixValues(simulation).split(' ').map(Number)

describe('simulations', () => {
  it('offers none first, then one entry per filter', () => {
    expect(SIMULATIONS.map((option) => option.value)).toEqual([
      'none',
      'grayscale',
      'protanopia',
      'deuteranopia',
      'tritanopia',
    ])
    expect(FILTERED_SIMULATIONS).toEqual(SIMULATIONS.slice(1).map((option) => option.value))
  })

  it('describes each in words, because a label alone does not say what is lost', () => {
    for (const { title } of SIMULATIONS) expect(title.length).toBeGreaterThan(8)
  })
})

describe('colorMatrixValues', () => {
  it.each(FILTERED_SIMULATIONS)('%s is a 4x5 feColorMatrix that leaves alpha alone', (name) => {
    const values = numbers(name)
    expect(values).toHaveLength(20)
    expect(values.every(Number.isFinite)).toBe(true)
    expect(values.slice(3, 5)).toEqual([0, 0])
    expect(values.slice(8, 10)).toEqual([0, 0])
    expect(values.slice(13, 15)).toEqual([0, 0])
    expect(values.slice(15)).toEqual([0, 0, 0, 1, 0])
  })

  it.each(FILTERED_SIMULATIONS)('%s keeps white white: each color row sums to 1', (name) => {
    const values = numbers(name)
    for (const row of [0, 1, 2]) {
      const sum = (values[row * 5] ?? 0) + (values[row * 5 + 1] ?? 0) + (values[row * 5 + 2] ?? 0)
      expect(sum).toBeCloseTo(1, 4)
    }
  })

  it('uses the Machado 2009 severity 1.0 matrices', () => {
    expect(numbers('protanopia').slice(0, 3)).toEqual([0.152286, 1.052583, -0.204868])
    expect(numbers('deuteranopia').slice(0, 3)).toEqual([0.367322, 0.860646, -0.227968])
    expect(numbers('tritanopia').slice(0, 3)).toEqual([1.255528, -0.076749, -0.178779])
  })

  it('makes grayscale the same luminance in every channel', () => {
    const values = numbers('grayscale')
    expect(values.slice(0, 3)).toEqual([0.2126, 0.7152, 0.0722])
    expect(values.slice(5, 8)).toEqual(values.slice(0, 3))
    expect(values.slice(10, 13)).toEqual(values.slice(0, 3))
  })
})

describe('visionFilter', () => {
  it('is no filter at all for none, so the wrapper is untouched', () => {
    expect(visionFilter('none')).toBeUndefined()
  })

  it.each(FILTERED_SIMULATIONS)('points %s at its own filter', (name) => {
    expect(visionFilter(name)).toBe(`url(#${filterId(name)})`)
  })

  it('gives every filter a distinct id', () => {
    const ids = FILTERED_SIMULATIONS.map(filterId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
