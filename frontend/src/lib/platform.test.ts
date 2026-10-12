import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMac, modKeyLabel } from './platform'

afterEach(() => vi.unstubAllGlobals())

describe('isMac', () => {
  it('reads userAgentData.platform when the browser has it', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: 'Win32' })
    expect(isMac()).toBe(true)
  })

  it('trusts userAgentData over the deprecated platform string', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })
    expect(isMac()).toBe(false)
  })

  it('falls back to navigator.platform without userAgentData', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(isMac()).toBe(true)
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(isMac()).toBe(false)
  })

  it('falls back when userAgentData reports an empty platform', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: '' }, platform: 'MacIntel' })
    expect(isMac()).toBe(true)
  })

  it('is false when there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined)
    expect(isMac()).toBe(false)
  })
})

describe('modKeyLabel', () => {
  it('is the Command symbol on macOS', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' } })
    expect(modKeyLabel()).toBe('⌘')
  })

  it('is Ctrl on every other platform', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' } })
    expect(modKeyLabel()).toBe('Ctrl')
  })
})
