import { useEffect, useId, useRef } from 'react'
import type { ChangePreview } from '@/lib/ruleChanges'
import { Button } from '@/ui/controls'
import { Notice } from '@/ui/states'

interface ChangeConfirmProps {
  /** What the change would end, from the API's contract. */
  preview: ChangePreview
  /** The rule's name, so the warning says which rule. */
  rule: string
  /** What the confirm button says: "Save and end incidents", "Disable the rule". */
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The warning before a change that ends open incidents: which rule, what ends, how many were open.
 * Nothing is applied until it is confirmed; the safe button (cancel) takes the focus first, and
 * Escape cancels. A change that ends nothing, or finds none open, never comes here.
 */
export function ChangeConfirm({
  preview,
  rule,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ChangeConfirmProps) {
  const titleId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
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
        status="warning"
        word="ENDS INCIDENTS"
        actions={
          <>
            <Button ref={cancel} onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
              {busy ? 'Saving…' : confirmLabel}
            </Button>
          </>
        }
      >
        <p id={titleId} className="type-body-strong">
          This change to “{rule}” ends open incidents.
        </p>
        <ul className="type-body flex flex-col gap-1 pt-1">
          {preview.notes.map((note) => (
            <li key={note.closes}>{note.text}</li>
          ))}
        </ul>
        <p className="type-body pt-1 text-fg-muted">
          They end when the engine next runs, and are not reopened by this rule as it was. A closed
          incident is not recovered: it stays in the history with the reason.
        </p>
      </Notice>
    </div>
  )
}
