/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A value without a current reading takes a tab stop so keyboard users can open its reason. */
import { Tooltip } from '@/ui/controls'

/** A current value, or a dash whose reason is available to pointer and keyboard users. */
export function Reading({ text, note }: { text: string; note?: string }) {
  return note ? (
    <Tooltip content={note}>
      <span tabIndex={0} aria-label={note} className="text-fg-muted">
        {text}
      </span>
    </Tooltip>
  ) : (
    <span>{text}</span>
  )
}
