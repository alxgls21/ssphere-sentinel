import { X } from 'lucide-react'
import { Fragment, useId, useRef } from 'react'
import { usePrefs } from '@/app/prefs'
import { useShell } from '@/app/shell'
import {
  SCOPE_ORDER,
  SCOPE_TITLE,
  SHORTCUTS,
  type Shortcut,
  type ShortcutScope,
} from '@/config/shortcuts'
import { IconButton, Kbd, ModKbd } from '@/ui/controls'
import { useModalDialog } from './useModalDialog'

const KEY_NAMES: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  shift: 'Shift',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
}

/** One key or chord ("mod+k", "shift+t", "?") as keycaps. */
function Chord({ spec }: { spec: string }) {
  const parts = spec.split('+')
  return parts.map((part) =>
    part === 'mod' ? (
      <ModKbd key={part} />
    ) : (
      <Kbd key={part}>
        {/* A lone letter reads as typed (p); inside a chord it reads as a keycap (Shift T). */}
        {KEY_NAMES[part] ?? (parts.length > 1 ? part.toUpperCase() : part)}
      </Kbd>
    ),
  )
}

/** A key, chord or sequence ("g o": press g, then o). */
function Keys({ spec }: { spec: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {spec.split(' ').map((step, index) => (
        <Fragment key={step}>
          {index > 0 ? <span className="type-data text-fg-faint">then</span> : null}
          <Chord spec={step} />
        </Fragment>
      ))}
    </span>
  )
}

function ScopeTable({ scope, shortcuts }: { scope: ShortcutScope; shortcuts: Shortcut[] }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="type-label pb-1 text-fg-muted">
        {SCOPE_TITLE[scope]}
      </h3>
      <table className="w-full">
        <thead className="sr-only">
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {shortcuts.map((shortcut) => (
            <tr key={shortcut.label} className="border-t border-border">
              <th scope="row" className="py-1 pr-3 text-left align-middle font-normal">
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  {(shortcut.shown ?? shortcut.keys).map((spec, index) => (
                    <Fragment key={spec}>
                      {index > 0 ? <span className="type-data text-fg-faint">or</span> : null}
                      <Keys spec={spec} />
                    </Fragment>
                  ))}
                </span>
              </th>
              <td className="type-body py-1 align-middle text-fg-muted">{shortcut.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * Every shortcut, printed from config/shortcuts so the sheet cannot drift from
 * the bindings. A native modal dialog: focus is trapped, Escape closes it and
 * focus returns to whatever opened it.
 */
export function ShortcutSheet() {
  const { shortcutsOpen, closeShortcuts } = useShell()
  const { singleKeyShortcuts } = usePrefs()
  const titleId = useId()
  const ref = useRef<HTMLDialogElement>(null)
  useModalDialog(ref, shortcutsOpen, closeShortcuts)

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto max-h-[85dvh] w-176 max-w-[calc(100vw-1.5rem)] flex-col rounded-md border border-border-strong bg-raised p-0 text-fg shadow-overlay open:flex"
    >
      {shortcutsOpen ? (
        <>
          <div className="flex shrink-0 items-center gap-3 border-b border-border-strong p-3">
            <h2 id={titleId} className="type-title">
              Keyboard shortcuts
            </h2>
            <IconButton
              aria-label="Close shortcuts"
              shortcut="Esc"
              icon={X}
              variant="ghost"
              onClick={closeShortcuts}
              className="ml-auto"
            />
          </div>
          <div className="min-h-0 overflow-y-auto p-3">
            <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
              {SCOPE_ORDER.map((scope) => (
                <ScopeTable
                  key={scope}
                  scope={scope}
                  shortcuts={SHORTCUTS.filter((shortcut) => shortcut.scope === scope)}
                />
              ))}
            </div>
            <p className="type-body pt-3 text-fg-muted">
              Single-key shortcuts are ignored while you type in a field. Ctrl/Cmd chords, Esc and
              the arrow keys inside a control always work, and the Display menu can switch
              single-key shortcuts off.
              {singleKeyShortcuts ? null : (
                <span className="type-body-strong text-fg"> They are off right now.</span>
              )}
            </p>
          </div>
        </>
      ) : null}
    </dialog>
  )
}
