import { describe, expect, it } from 'vitest'
import { loginPath, safeNextPath } from './safeNext'

describe('safeNextPath', () => {
  it('keeps a path inside the application, with its query and hash', () => {
    expect(safeNextPath('/servers')).toBe('/servers')
    expect(safeNextPath('/servers/abc?range=6h&q=db#top')).toBe('/servers/abc?range=6h&q=db#top')
    expect(safeNextPath('/')).toBe('/')
  })

  it.each([
    ['an absolute URL', 'https://evil.example/servers'],
    ['a protocol-relative URL', '//evil.example/servers'],
    ['a protocol-relative URL with a backslash', '/\\evil.example'],
    ['a backslash path', '\\\\evil.example'],
    ['a slash-backslash prefix', '/\\/evil.example'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,x'],
    ['a relative path', 'servers'],
    ['a tab hidden in the slashes', '/\t/evil.example'],
    ['a newline hidden in the slashes', '/\n/evil.example'],
    ['a carriage return', '/\r/evil.example'],
    ['a NUL byte', '/servers\u0000'],
    ['an empty string', ''],
    ['a whitespace-led URL', ' https://evil.example'],
    ['a very long path', `/${'a'.repeat(3000)}`],
  ])('falls back for %s', (_name, raw) => {
    expect(safeNextPath(raw)).toBe('/')
  })

  it('falls back for nothing at all', () => {
    expect(safeNextPath(null)).toBe('/')
    expect(safeNextPath(undefined)).toBe('/')
  })

  it('never sends the user back to the sign-in page (no redirect loop)', () => {
    expect(safeNextPath('/login')).toBe('/')
    expect(safeNextPath('/login?next=/servers')).toBe('/')
    expect(safeNextPath('/login/')).toBe('/')
    expect(safeNextPath('/setup')).toBe('/')
    expect(safeNextPath('/setup?next=/servers')).toBe('/')
  })

  it('uses the fallback it is given', () => {
    expect(safeNextPath('//evil.example', '/servers')).toBe('/servers')
  })

  it('normalises dot segments instead of echoing them', () => {
    expect(safeNextPath('/servers/../servers')).toBe('/servers')
    expect(safeNextPath('/a/..//evil.example')).toBe('/')
  })
})

describe('loginPath', () => {
  it('goes to the sign-in page, remembering where the user was', () => {
    expect(loginPath('/servers?range=6h')).toBe('/login?next=%2Fservers%3Frange%3D6h')
  })

  it('stays plain for the home page and says when a session ended', () => {
    expect(loginPath('/')).toBe('/login')
    expect(loginPath('/', 'expired')).toBe('/login?reason=expired')
  })

  it('never writes an unsafe destination into the address', () => {
    expect(loginPath('//evil.example')).toBe('/login')
  })
})
