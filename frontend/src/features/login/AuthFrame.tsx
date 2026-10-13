import type { ReactNode } from 'react'
import { Wordmark } from '@/ui/Wordmark'

/** The page the sign-in and session screens sit on: no shell, just the wordmark and one panel. */
export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 text-fg">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Wordmark />
        <section
          aria-labelledby="auth-title"
          className="flex flex-col gap-4 rounded-sm border border-border bg-panel p-4"
        >
          <h1 id="auth-title" className="type-title">
            {title}
          </h1>
          {children}
        </section>
      </div>
    </main>
  )
}
