import { Link, useLocation } from 'react-router'
import { useViewSearch } from '@/app/viewSearch'

/** The catch-all route, rendered inside the shell so navigation stays at hand. */
export function NotFoundPage() {
  const { pathname } = useLocation()
  const search = useViewSearch()
  return (
    <article className="flex max-w-prose flex-col gap-3 rounded-sm border border-border bg-panel p-3">
      <h1 className="type-title">Page not found</h1>
      <p className="type-body text-fg-muted">
        There is no screen at <code className="type-data text-fg">{pathname}</code>.
      </p>
      <Link
        to={{ pathname: '/', search }}
        className="type-data-strong w-fit text-primary underline underline-offset-2 hover:text-primary-hover"
      >
        Go to Overview
      </Link>
    </article>
  )
}
