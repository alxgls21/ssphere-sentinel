import { useId, type ReactNode } from 'react'
import { CopyButton } from '@/ui/CopyButton'

interface CodeBlockProps {
  /** The heading of the block, and the accessible name of the text. */
  title: string
  /** What the copy button says it copies: "Entry", "Commands". */
  what: string
  text: string
  /** One line under the heading: where the text goes. */
  children?: ReactNode
}

/** Text to copy as it is (a file entry, commands): a heading, a copy button and the text, verbatim. */
export function CodeBlock({ title, what, text, children }: CodeBlockProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="type-label text-fg-muted">
          {title}
        </h3>
        <CopyButton text={text} label={`Copy ${what.toLowerCase()}`} what={what} />
      </div>
      {children ? <p className="type-body text-fg-faint">{children}</p> : null}
      <pre
        aria-label={`${what} text`}
        className="type-data max-h-96 overflow-auto rounded-sm border border-border bg-raised p-3 whitespace-pre"
      >
        <code>{text}</code>
      </pre>
    </section>
  )
}
