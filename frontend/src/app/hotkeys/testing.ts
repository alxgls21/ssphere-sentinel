import type { KeyInput } from './engine'

/**
 * The key event a shortcut spec ("mod+k", "shift+t", "g", "?", "escape")
 * produces on a US keyboard, as plain data. `mac` makes "mod" Command.
 */
export function keyInit(spec: string, mac = false): KeyInput & KeyboardEventInit {
  const parts = spec.split('+')
  const base = parts.pop() as string
  const mod = parts.includes('mod')
  const shift = parts.includes('shift')
  const event = {
    key: base,
    code: '',
    ctrlKey: mod && !mac,
    metaKey: mod && mac,
    altKey: false,
    shiftKey: shift || base === '?',
  }
  if (/^[a-z]$/.test(base)) {
    event.code = `Key${base.toUpperCase()}`
    event.key = shift ? base.toUpperCase() : base
  } else if (/^\d$/.test(base)) event.code = `Digit${base}`
  else if (base === 'escape') Object.assign(event, { key: 'Escape', code: 'Escape' })
  return event
}
