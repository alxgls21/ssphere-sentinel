import { ChevronRight } from 'lucide-react'
import { Fragment } from 'react'
import { LiveCursor } from './LiveCursor'
import { useFreshness } from './useFreshness'

/**
 * The shell-prompt breadcrumb ("sentinel › acme › overview") ending in the live
 * cursor. The last segment is the screen, in the text colour; earlier ones are
 * context, in faint.
 */
export function BreadcrumbPrompt({ segments }: { segments: readonly string[] }) {
  const { state } = useFreshness()
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ol aria-label="Location" className="type-prompt flex min-w-0 items-center gap-1.5">
        {segments.map((segment, index) => {
          const last = index === segments.length - 1
          return (
            <Fragment key={`${index}:${segment}`}>
              {index > 0 ? (
                <li aria-hidden="true" className="flex shrink-0">
                  <ChevronRight size={14} strokeWidth={1.5} className="text-fg-faint" />
                </li>
              ) : null}
              <li
                aria-current={last ? 'page' : undefined}
                className={last ? 'min-w-0 truncate text-fg' : 'min-w-0 truncate text-fg-faint'}
              >
                {segment}
              </li>
            </Fragment>
          )
        })}
      </ol>
      <LiveCursor state={state} />
    </div>
  )
}
