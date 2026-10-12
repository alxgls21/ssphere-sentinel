import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from '@/config/shortcuts'
import { isTypingTarget, resolveKey, type KeyContext, type KeyInput } from './engine'
import { keyInit } from './testing'

const NORMAL: KeyContext = { mac: false, typing: false, singleKeys: true, overlayOpen: false }

const press = (spec: string, context: Partial<KeyContext> = {}, pending: string | null = null) =>
  resolveKey(keyInit(spec, context.mac), pending, { ...NORMAL, ...context })

describe('resolveKey: single keys', () => {
  it('binds the registry actions', () => {
    expect(press('p')).toEqual({ type: 'run', action: 'pause', binding: 'p' })
    expect(press('r')).toEqual({ type: 'run', action: 'refresh', binding: 'r' })
    expect(press('z')).toEqual({ type: 'run', action: 'timezone', binding: 'z' })
    expect(press('/')).toEqual({ type: 'run', action: 'palette', binding: '/' })
  })

  it('tells t from Shift+T and n from Shift+N', () => {
    expect(press('t')).toMatchObject({ action: 'range-next' })
    expect(press('shift+t')).toMatchObject({ action: 'range-prev' })
    expect(press('n')).toMatchObject({ action: 'next-problem' })
    expect(press('shift+n')).toMatchObject({ action: 'previous-problem' })
  })

  it('reports which digit focused a panel', () => {
    expect(press('3')).toEqual({ type: 'run', action: 'focus-panel', binding: '3' })
    expect(press('7')).toEqual({ type: 'ignore' })
  })

  it('ignores keys that are not bound', () => {
    expect(press('x')).toEqual({ type: 'ignore' })
    expect(press('j')).toEqual({ type: 'ignore' })
  })
})

describe('resolveKey: layouts', () => {
  const greek = (key: string, code: string): KeyInput => ({
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  })

  it('matches letters by physical key, so Greek and Cyrillic layouts work', () => {
    expect(resolveKey(greek('π', 'KeyP'), null, NORMAL)).toMatchObject({ action: 'pause' })
    expect(resolveKey(greek('з', 'KeyP'), null, NORMAL)).toMatchObject({ action: 'pause' })
    expect(resolveKey(greek('ρ', 'KeyR'), null, NORMAL)).toMatchObject({ action: 'refresh' })
  })

  it('matches Ctrl+K by physical key too', () => {
    const event = { ...greek('κ', 'KeyK'), ctrlKey: true }
    expect(resolveKey(event, null, NORMAL)).toMatchObject({ action: 'palette' })
  })

  it('matches punctuation by the character it produces, with or without Shift', () => {
    const bracket = { ...greek('[', 'BracketLeft') }
    expect(resolveKey(bracket, null, NORMAL)).toMatchObject({ action: 'sidebar' })
    const question = { ...greek('?', 'Slash'), shiftKey: true }
    expect(resolveKey(question, null, NORMAL)).toMatchObject({ action: 'shortcuts' })
    // On a layout where "?" needs no Shift the character is still what counts.
    expect(resolveKey(greek('?', 'Minus'), null, NORMAL)).toMatchObject({ action: 'shortcuts' })
  })

  it('does not take a letter typed with AltGr or Alt for a shortcut', () => {
    expect(resolveKey({ ...greek('p', 'KeyP'), altKey: true }, null, NORMAL)).toEqual({
      type: 'ignore',
    })
    // AltGr reports Ctrl+Alt on Windows.
    expect(
      resolveKey({ ...greek('p', 'KeyP'), altKey: true, ctrlKey: true }, null, NORMAL),
    ).toEqual({ type: 'ignore' })
  })
})

describe('resolveKey: modifiers', () => {
  it('uses Ctrl off macOS and Command on macOS for the modifier chords', () => {
    expect(press('mod+k')).toMatchObject({ action: 'palette' })
    expect(press('mod+k', { mac: true })).toMatchObject({ action: 'palette' })
    // The other modifier is not an alias: Ctrl+K on a Mac is the text field's "kill line".
    const ctrlOnMac = { ...keyInit('k'), ctrlKey: true }
    expect(resolveKey(ctrlOnMac, null, { ...NORMAL, mac: true })).toEqual({ type: 'ignore' })
    const metaOffMac = { ...keyInit('k'), metaKey: true }
    expect(resolveKey(metaOffMac, null, NORMAL)).toEqual({ type: 'ignore' })
  })

  it('binds the non-punctuation alternates', () => {
    expect(press('mod+/')).toMatchObject({ action: 'shortcuts' })
    expect(press('mod+b')).toMatchObject({ action: 'sidebar' })
  })

  it('never reads a single-character shortcut with Ctrl, Alt or Meta held', () => {
    expect(resolveKey({ ...keyInit('p'), ctrlKey: true }, null, NORMAL)).toEqual({
      type: 'ignore',
    })
    expect(resolveKey({ ...keyInit('p'), metaKey: true }, null, NORMAL)).toEqual({
      type: 'ignore',
    })
    expect(resolveKey({ ...keyInit('p'), altKey: true }, null, NORMAL)).toEqual({ type: 'ignore' })
    expect(resolveKey({ ...keyInit('1'), ctrlKey: true }, null, NORMAL)).toEqual({
      type: 'ignore',
    })
  })
})

describe('resolveKey: when single keys are suspended', () => {
  it('ignores single-character shortcuts while typing in a field', () => {
    for (const spec of ['p', '/', '?', '[', 't', 'shift+t', '1', 'n']) {
      expect(press(spec, { typing: true }), spec).toEqual({ type: 'ignore' })
    }
  })

  it('still runs the Ctrl/Cmd chords and Escape inside a field', () => {
    expect(press('mod+k', { typing: true })).toMatchObject({ action: 'palette' })
    expect(press('mod+/', { typing: true })).toMatchObject({ action: 'shortcuts' })
    expect(press('mod+b', { typing: true })).toMatchObject({ action: 'sidebar' })
    expect(press('escape', { typing: true })).toMatchObject({ action: 'dismiss' })
  })

  it('ignores single-character shortcuts when the operator switched them off', () => {
    for (const spec of ['p', 'r', 'z', '/', '?', '[', '2', 'g']) {
      expect(press(spec, { singleKeys: false }), spec).toEqual({ type: 'ignore' })
    }
  })

  it('keeps Ctrl/Cmd+K, the chords and Esc working with single keys off (WCAG 2.1.4)', () => {
    expect(press('mod+k', { singleKeys: false })).toMatchObject({ action: 'palette' })
    expect(press('mod+b', { singleKeys: false })).toMatchObject({ action: 'sidebar' })
    expect(press('escape', { singleKeys: false })).toMatchObject({ action: 'dismiss' })
  })

  it('lets an open overlay swallow everything except Escape', () => {
    const open = { overlayOpen: true }
    for (const spec of ['p', 'r', 'g', '/', '?', '1', 'mod+k', 'mod+b']) {
      expect(press(spec, open), spec).toEqual({ type: 'ignore' })
    }
    expect(press('escape', open)).toMatchObject({ action: 'dismiss' })
  })
})

describe('resolveKey: sequences', () => {
  it('waits after the first key of a chord', () => {
    expect(press('g')).toEqual({ type: 'pending', keys: 'g' })
  })

  it('completes a chord with the second key', () => {
    expect(press('o', {}, 'g')).toEqual({ type: 'run', action: 'go', binding: 'g o' })
    expect(press('s', {}, 'g')).toEqual({ type: 'run', action: 'go', binding: 'g s' })
  })

  it('reads the second key as part of the chord, not as its own shortcut', () => {
    // "g p" is SNMP, not "pause".
    expect(press('p', {}, 'g')).toEqual({ type: 'run', action: 'go', binding: 'g p' })
    // "g r" is nothing: it must not refresh.
    expect(press('r', {}, 'g')).toEqual({ type: 'cancel' })
  })

  it('cancels on Escape, on a key that is not part of a chord and on a modifier chord', () => {
    expect(press('escape', {}, 'g')).toEqual({ type: 'cancel' })
    expect(press('x', {}, 'g')).toEqual({ type: 'cancel' })
    expect(press('mod+k', {}, 'g')).toEqual({ type: 'cancel' })
  })

  it('cancels when focus moved into a field, or an overlay opened, meanwhile', () => {
    expect(press('o', { typing: true }, 'g')).toEqual({ type: 'cancel' })
    expect(press('o', { overlayOpen: true }, 'g')).toEqual({ type: 'cancel' })
    expect(press('o', { singleKeys: false }, 'g')).toEqual({ type: 'cancel' })
  })

  it('does not start a chord from Shift+G', () => {
    expect(press('shift+g')).toEqual({ type: 'ignore' })
  })
})

describe('the registry and the engine agree (documentation cannot drift)', () => {
  const bound = SHORTCUTS.flatMap((shortcut) =>
    shortcut.action ? shortcut.keys.map((spec) => ({ spec, action: shortcut.action })) : [],
  )

  it.each(bound)('$spec runs $action', ({ spec, action }) => {
    const steps = spec.split(' ')
    const first = press(steps[0] as string)
    if (steps.length === 1) {
      expect(first).toMatchObject({ type: 'run', action, binding: spec })
      return
    }
    expect(first).toEqual({ type: 'pending', keys: steps[0] })
    expect(press(steps[1] as string, {}, steps[0] as string)).toMatchObject({
      type: 'run',
      action,
      binding: spec,
    })
  })

  it('binds nothing for documentation-only entries', () => {
    const documented = SHORTCUTS.filter((shortcut) => !shortcut.action).flatMap((s) => s.keys)
    for (const spec of ['j', 'k', 'y', 'f', 'v', 'enter']) expect(documented).toContain(spec)
    for (const spec of ['j', 'k', 'y', 'f', 'v']) expect(press(spec)).toEqual({ type: 'ignore' })
  })
})

describe('isTypingTarget', () => {
  const html = (markup: string) => {
    const host = document.createElement('div')
    host.innerHTML = markup
    document.body.append(host)
    return host
  }

  it('is true inside inputs, textareas, selects and contenteditable regions', () => {
    const host = html(
      '<input id="i"><textarea id="t"></textarea><select id="s"></select>' +
        '<div contenteditable="true"><span id="c"></span></div>' +
        '<div contenteditable="plaintext-only" id="p"></div>',
    )
    for (const id of ['i', 't', 's', 'c', 'p']) {
      expect(isTypingTarget(host.querySelector(`#${id}`)), id).toBe(true)
    }
    host.remove()
  })

  it('is false for buttons, links, plain elements and nothing', () => {
    const host = html(
      '<button id="b"></button><a id="a" href="/x"></a><div contenteditable="false" id="n"></div>',
    )
    for (const id of ['b', 'a', 'n'])
      expect(isTypingTarget(host.querySelector(`#${id}`)), id).toBe(false)
    expect(isTypingTarget(document.body)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    host.remove()
  })
})
