import { SHORTCUTS, type ShortcutAction } from '@/config/shortcuts'

/** How long the second key of a sequence ("g" then "o") may take. */
export const CHORD_TIMEOUT_MS = 1200

/** The part of a KeyboardEvent the engine reads (tests pass plain objects). */
export interface KeyInput {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export interface KeyContext {
  /** Command is the shortcut modifier on macOS, Ctrl elsewhere. */
  mac: boolean
  /** Focus is in a text field (input, textarea, select, contenteditable). */
  typing: boolean
  /** The operator's Display setting; off satisfies WCAG 2.1.4. */
  singleKeys: boolean
  /** A modal overlay (palette, shortcut sheet, navigation drawer) is open. */
  overlayOpen: boolean
}

export type Resolution =
  | { type: 'run'; action: ShortcutAction; binding: string }
  /** The first key of a sequence was accepted: wait for the second. */
  | { type: 'pending'; keys: string }
  /** A sequence was pending and this key did not complete it. */
  | { type: 'cancel' }
  | { type: 'ignore' }

interface Step {
  /** The source text, e.g. "g" or "mod+k". */
  spec: string
  /** Letters and digits match event.code; punctuation and named keys match event.key. */
  by: 'code' | 'key'
  value: string
  mod: boolean
  shift: boolean
}

interface Binding {
  action: ShortcutAction
  /** The whole source text, e.g. "g o". */
  spec: string
  steps: readonly Step[]
  /**
   * A modifier chord or Escape: these work inside fields and with single-key
   * shortcuts off. Everything else is a single-character shortcut.
   */
  always: boolean
}

const NAMED_KEYS: Readonly<Record<string, string>> = { escape: 'Escape' }

function parseStep(spec: string): Step {
  const parts = spec.split('+')
  const base = parts.pop() ?? ''
  const modifiers = new Set(parts)
  for (const modifier of modifiers) {
    if (modifier !== 'mod' && modifier !== 'shift') {
      throw new Error(`shortcut "${spec}": unknown modifier "${modifier}"`)
    }
  }
  const mod = modifiers.has('mod')
  const shift = modifiers.has('shift')
  if (/^[a-z]$/.test(base))
    return { spec, by: 'code', value: `Key${base.toUpperCase()}`, mod, shift }
  if (/^\d$/.test(base)) return { spec, by: 'code', value: `Digit${base}`, mod, shift }
  const named = NAMED_KEYS[base]
  if (named) return { spec, by: 'key', value: named, mod, shift }
  if (base.length === 1) return { spec, by: 'key', value: base, mod, shift }
  throw new Error(`shortcut "${spec}": "${base}" cannot be bound globally`)
}

/** Built once from the registry: documentation-only entries carry no action and bind nothing. */
const BINDINGS: readonly Binding[] = SHORTCUTS.flatMap(({ action, keys }) =>
  action
    ? keys.map((spec): Binding => {
        const steps = spec.split(' ').map(parseStep)
        const [first] = steps
        return { action, spec, steps, always: Boolean(first?.mod) || action === 'dismiss' }
      })
    : [],
)

function matches(step: Step, event: KeyInput, mac: boolean): boolean {
  const modifierDown = mac ? event.metaKey : event.ctrlKey
  const otherModifierDown = mac ? event.ctrlKey : event.metaKey
  // Alt (and AltGr, which reports Ctrl+Alt) produces other characters: never a shortcut.
  if (event.altKey || otherModifierDown || modifierDown !== step.mod) return false
  // Punctuation ignores Shift: "?" needs it on a US layout but not on every other.
  return step.by === 'code'
    ? event.code === step.value && event.shiftKey === step.shift
    : event.key === step.value
}

/**
 * Decides what a key press means. Pure: the provider owns the timer, the focus
 * tracking and the side effects.
 *
 *   - single-character shortcuts are ignored in fields, with Display > Single-key
 *     shortcuts off, and (like everything else) while an overlay is open;
 *   - Ctrl/Cmd chords work in fields and with single keys off;
 *   - with a sequence pending only its second key counts, and any other key cancels it.
 */
export function resolveKey(
  event: KeyInput,
  pending: string | null,
  context: KeyContext,
): Resolution {
  const { mac, typing, singleKeys, overlayOpen } = context

  if (pending !== null) {
    if (typing || !singleKeys || overlayOpen) return { type: 'cancel' }
    const hit = BINDINGS.find(
      ({ steps }) =>
        steps.length === 2 &&
        steps[0]?.spec === pending &&
        steps[1] !== undefined &&
        matches(steps[1], event, mac),
    )
    return hit ? { type: 'run', action: hit.action, binding: hit.spec } : { type: 'cancel' }
  }

  for (const binding of BINDINGS) {
    const [first] = binding.steps
    if (!first || !matches(first, event, mac)) continue
    // Overlays swallow everything except Escape.
    if (overlayOpen && binding.action !== 'dismiss') continue
    if (!binding.always && (typing || !singleKeys)) continue
    return binding.steps.length === 2
      ? { type: 'pending', keys: first.spec }
      : { type: 'run', action: binding.action, binding: binding.spec }
  }
  return { type: 'ignore' }
}

const FIELD_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'

/** Focus (or the event target) is inside something the operator types into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FIELD_SELECTOR) !== null
}
