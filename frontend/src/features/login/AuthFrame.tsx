import type { ReactNode } from 'react'
import { Wordmark } from '@/ui/Wordmark'

/**
 * The page the sign-in and session screens sit on: no shell, just the wordmark and one panel.
 * The panel's title bar reads like a terminal session line; it is decoration and says nothing the
 * heading does not.
 */
export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 text-fg">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Wordmark />
        <section
          aria-labelledby="auth-title"
          className="flex flex-col overflow-hidden rounded-sm border border-border bg-panel"
        >
          <div
            aria-hidden="true"
            className="type-data flex items-center justify-between gap-3 border-b border-border bg-raised px-4 py-1.5 text-fg-muted"
          >
            <span className="truncate">sentinel ~ {title.toLowerCase()}</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary" />
              console
            </span>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <h1 id="auth-title" className="type-title">
              <span aria-hidden="true" className="mr-2 text-primary">
                &gt;
              </span>
              {title}
            </h1>
            {children}
          </div>
        </section>
      </div>
    </main>
  )
}
