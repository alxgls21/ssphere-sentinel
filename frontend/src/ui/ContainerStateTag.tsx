import type { ServerContainer } from '@/api/types'
import { containerWord, endedText } from '@/lib/containers'
import { Tooltip } from '@/ui/controls'
import { StatusTag } from '@/ui/status'

/**
 * A container's status tag. For one that exited, how it ended (its exit code, or a kill for memory) is
 * said in a tooltip a keyboard can reach, and named for assistive technology: the word alone, CRASHED,
 * does not say what happened.
 */
export function ContainerStateTag({ row }: { row: ServerContainer }) {
  const tag = <StatusTag status={row.status} word={containerWord(row)} variant="tag" />
  const ended = endedText(row)
  if (ended === null) return tag
  return (
    <Tooltip content={`${row.container.name} ${ended}`}>
      {/* A read, not an operation: the stop exists so the sentence reaches the keyboard. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <span tabIndex={0} aria-label={`${containerWord(row)}: ${ended}`} className="inline-flex">
        {tag}
      </span>
    </Tooltip>
  )
}
