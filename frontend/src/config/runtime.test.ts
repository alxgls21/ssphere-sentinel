import { describe, expect, it } from 'vitest'
import { ConfigurationError, resolveApiMode } from './runtime'

describe('resolveApiMode', () => {
  it('defaults to the console API, in development and in production', () => {
    expect(resolveApiMode({ PROD: false })).toBe('http')
    expect(resolveApiMode({ PROD: true })).toBe('http')
    expect(resolveApiMode({ PROD: true, VITE_SENTINEL_API: '' })).toBe('http')
    expect(resolveApiMode({ PROD: true, VITE_SENTINEL_API: ' HTTP ' })).toBe('http')
  })

  it('allows mock mode in development only when it is asked for', () => {
    expect(resolveApiMode({ PROD: false, VITE_SENTINEL_API: 'mock' })).toBe('mock')
  })

  it('refuses mock mode in a production build instead of falling back to either mode', () => {
    expect(() => resolveApiMode({ PROD: true, VITE_SENTINEL_API: 'mock' })).toThrow(
      ConfigurationError,
    )
  })

  it('refuses a value it does not know, in any build', () => {
    expect(() => resolveApiMode({ PROD: false, VITE_SENTINEL_API: 'demo' })).toThrow(
      /"http" or "mock"/,
    )
    expect(() => resolveApiMode({ PROD: true, VITE_SENTINEL_API: 'false' })).toThrow(
      ConfigurationError,
    )
  })
})
