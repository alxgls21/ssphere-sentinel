import { useContext, useEffect, useRef, useState } from 'react'
import { ShellContext } from '@/app/shell'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/ui/controls'

/** How long a copy button says "Copied" before it offers to copy again. */
const COPIED_MS = 2000

interface CopyButtonProps {
  text: string
  /** What the button says: "Copy token", "Copy entry". */
  label: string
  /** What was copied, for the status line and the accessible name: "Token", "Entry". */
  what: string
}

/**
 * Copies `text` on the operator's click and says so, in the button and in the status line. Shared
 * by the agent enrolment (a token, the commands) and the target's entry for the agent's file.
 */
export function CopyButton({ text, label, what }: CopyButtonProps) {
  const shell = useContext(ShellContext)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <Button
      size="sm"
      aria-label={copied ? `${what} copied` : label}
      onClick={() => {
        void copyText(text).then((ok) => {
          setCopied(ok)
          shell?.flashStatus(
            ok ? `${what} copied` : `Could not copy: select the ${what.toLowerCase()} and copy it`,
          )
          clearTimeout(timer.current)
          if (ok) timer.current = setTimeout(() => setCopied(false), COPIED_MS)
        })
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}
