import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { useMockScenario, useSetMockScenario } from './scenario'

function setup(route = '/') {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [route] }, children)
  return renderHook(
    () => ({ scenario: useMockScenario(), set: useSetMockScenario(), location: useLocation() }),
    { wrapper },
  )
}

describe('the mock scenario in the URL', () => {
  it('reads ?mock=, defaulting to normal', () => {
    expect(setup('/?mock=empty').result.current.scenario).toBe('empty')
    expect(setup('/').result.current.scenario).toBe('normal')
    expect(setup('/?mock=bogus').result.current.scenario).toBe('normal')
  })

  it('writes it through the router, keeping the rest of the view', () => {
    const { result } = setup('/servers?range=6h&customer=c1')
    act(() => result.current.set('stale'))
    expect(result.current.scenario).toBe('stale')
    expect(new URLSearchParams(result.current.location.search).toString()).toBe(
      'range=6h&customer=c1&mock=stale',
    )
    // Normal is the absence of the parameter, so a clean URL stays clean.
    act(() => result.current.set('normal'))
    expect(result.current.location.search).toBe('?range=6h&customer=c1')
  })
})
