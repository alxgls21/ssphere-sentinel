import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, FieldInput } from '@/ui/controls'
import { Notice } from '@/ui/states'

interface DeleteConfirmProps {
  /** What is being deleted: "customer", "server". */
  kind: string
  /** The name the operator must type, letter for letter. */
  name: string
  /** What goes with it and what stays, in the server's own terms. */
  children: ReactNode
  /** What the confirm button says; "Delete <kind>" by default. */
  confirmLabel?: string
  busy?: boolean
  /** Why the last attempt was refused (the server's message), shown inside until the next try. */
  problem?: string | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The confirmation before a deletion: which object, what it takes with it, and the object's name
 * typed back before the button does anything. The safe button (cancel) takes the focus first,
 * Escape cancels, and nothing is deleted until the typed name matches. A refusal of the server
 * (something still belongs to it) is shown here, with its own words.
 */
export function DeleteConfirm({
  kind,
  name,
  children,
  confirmLabel,
  busy = false,
  problem = null,
  onConfirm,
  onCancel,
}: DeleteConfirmProps) {
  const titleId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => cancel.current?.focus(), [])
  const matches = typed.trim() === name
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels, from wherever the focus is inside
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <Notice
        status="critical"
        word="DELETE"
        actions={
          <>
            <Button ref={cancel} onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              disabled={busy || !matches}
              aria-busy={busy}
            >
              {busy ? 'Deleting…' : (confirmLabel ?? `Delete ${kind}`)}
            </Button>
          </>
        }
      >
        <p id={titleId} className="type-body-strong">
          Delete the {kind} “{name}”?
        </p>
        <div className="type-body flex flex-col gap-1 pt-1">{children}</div>
        {problem ? (
          <p role="alert" className="type-body-strong pt-1">
            {problem}
          </p>
        ) : null}
        <FieldInput
          label={`Type the ${kind}’s name to confirm`}
          value={typed}
          onChange={setTyped}
          input={{ disabled: busy, autoComplete: 'off', spellCheck: false }}
          hint={`Exactly “${name}”. Nothing is deleted until it matches.`}
          className="max-w-sm pt-2"
        />
      </Notice>
    </div>
  )
}
