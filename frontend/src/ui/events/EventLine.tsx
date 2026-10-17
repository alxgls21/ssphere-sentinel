/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions --
   A log line is read, not operated. It is focusable anyway so a keyboard user can stop the tail
   (focus pauses it) and walk it with the arrow keys that the log wires up. */
import type { KeyboardEventHandler, Ref } from 'react'
import { formatTime, type Timezone } from '@/lib/format'
import { StatusGlyph } from '@/ui/status'
import { LEVEL_NAME, LEVEL_STATUS, type Guide, type TailLine } from './eventModel'

/**
 * One cell of the tree guide, drawn with borders (the font subsets carry no box-drawing
 * characters). Cells are 16px wide and the line is 24px, so vertical strokes of adjacent lines meet.
 */
function GuideCell({ kind }: { kind: Guide }) {
  return (
    <span className="relative w-4 shrink-0">
      {kind === 'pipe' || kind === 'tee' ? (
        <span className="absolute inset-y-0 left-1/2 border-l border-border-strong" />
      ) : null}
      {kind === 'tee' ? (
        <span className="absolute top-1/2 right-0 left-1/2 border-t border-border-strong" />
      ) : null}
      {kind === 'elbow' ? (
        <span className="absolute top-0 left-1/2 h-1/2 w-1/2 border-b border-l border-border-strong" />
      ) : null}
    </span>
  )
}

interface EventLineProps {
  line: TailLine
  tz: Timezone
  tabIndex: 0 | -1
  ref: Ref<HTMLLIElement>
  onFocus: () => void
  onKeyDown: KeyboardEventHandler<HTMLLIElement>
}

/** A 24px line: time, level glyph, entity, message. A nested line is indented under its parent by the guide. */
export function EventLine({ line, tz, tabIndex, ref, onFocus, onKeyDown }: EventLineProps) {
  const { event, depth, guides } = line
  const clock = `${formatTime(Date.parse(event.at), tz)}${tz === 'utc' ? 'Z' : ''}`
  return (
    <li
      ref={ref}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      aria-level={depth > 0 ? depth + 1 : undefined}
      className="flex h-6 items-center gap-2 px-3 transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:-outline-offset-2"
    >
      {guides.length > 0 ? (
        <span aria-hidden="true" className="flex self-stretch">
          {guides.map((kind, index) => (
            <GuideCell key={index} kind={kind} />
          ))}
        </span>
      ) : null}
      <time dateTime={event.at} className="type-data shrink-0 text-fg-faint">
        {clock}
      </time>
      <StatusGlyph status={LEVEL_STATUS[event.level]} size={10} label={LEVEL_NAME[event.level]} />
      <span className="type-data max-w-[40%] shrink-0 truncate">{event.subject.name}</span>
      <span className="type-body min-w-0 flex-1 truncate">{event.message}</span>
    </li>
  )
}
