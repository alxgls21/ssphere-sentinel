import { useState, type ReactNode } from 'react'
import { Button } from '@/ui/controls'
import { Skeleton, SkeletonRows } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { LiveCursor } from '@/shell/topbar/LiveCursor'
import { useReducedMotion } from '@/shell/useReducedMotion'
import { Specimen } from '../Specimen'

interface ReplayProps {
  /** The utility class the demonstration uses. */
  utility: string
  /** When the console uses it, and for how long. */
  rule: string
  children: ReactNode
}

/**
 * Remounts its content to restart a CSS animation: the animation plays when
 * the element is created, so a new key is a replay. An endless one starts over.
 */
function Replay({ utility, rule, children }: ReplayProps) {
  const [run, setRun] = useState(0)
  return (
    <Specimen label={utility} note={rule} className="flex items-center justify-between gap-3">
      <div key={run} className="flex min-h-8 min-w-0 flex-1 items-center">
        {children}
      </div>
      <Button
        size="sm"
        onClick={() => setRun((count) => count + 1)}
        aria-label={`Replay ${utility}`}
      >
        Replay
      </Button>
    </Specimen>
  )
}

const CURSOR_STATES = ['live', 'fetching', 'paused', 'stale', 'nodata'] as const

export function MotionSection() {
  const reduced = useReducedMotion()
  return (
    <div className="flex flex-col gap-3">
      <p className="type-body text-fg-muted">
        Reduced motion is {reduced ? 'on' : 'off'}.{' '}
        {reduced
          ? 'Every animation below is removed, so replay shows only the end state.'
          : 'The OS setting or the Display menu removes every animation below.'}
      </p>
      <div className="grid gap-x-3 gap-y-4 lg:grid-cols-2">
        <Replay
          utility="animate-flash"
          rule="A changed value flashes the selection tint and fades out over 600ms. An unchanged value never animates, and numbers do not count up."
        >
          <span className="type-data-strong tnum animate-flash rounded-sm px-1.5 py-0.5">
            142 ms
          </span>
        </Replay>
        <Replay
          utility="animate-crit-in"
          rule="A new critical row gets one 1.2s inset outline that fades. Never a loop, never a background change."
        >
          <div className="animate-crit-in flex h-(--row-h) w-full items-center gap-3 rounded-sm px-3">
            <StatusTag status="critical" word="OFFLINE" variant="tag" />
            <span className="type-data-strong">edge-gw-02</span>
          </div>
        </Replay>
        <Replay
          utility="animate-cursor"
          rule="The live cursor blinks in steps, at 1 Hz, only while a request is in flight. Solid when live, hollow when paused, struck through when stale or without data."
        >
          <ul className="flex flex-wrap items-end gap-4">
            {CURSOR_STATES.map((state) => (
              <li key={state} className="flex flex-col items-center gap-1.5">
                <LiveCursor state={state} />
                <span className="type-tag text-fg-faint">{state}</span>
              </li>
            ))}
          </ul>
        </Replay>
        <Replay
          utility="animate-skeleton"
          rule="A 1.6s opacity pulse on first load only, after a 150ms delay. Static under reduced motion."
        >
          <div className="flex w-full flex-col gap-3">
            <Skeleton className="h-8 w-40" />
            <SkeletonRows count={2} />
          </div>
        </Replay>
        <Replay
          utility="animate-overlay-in"
          rule="Menus and tooltips fade in over 120ms with a 4px rise."
        >
          <div className="type-data animate-overlay-in rounded-md border border-border-strong bg-raised px-3 py-2 shadow-overlay">
            Refresh now
          </div>
        </Replay>
      </div>
    </div>
  )
}
