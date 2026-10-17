import { Link } from 'react-router'
import { FEATURES, describeAvailability, isPlaceholder, shortfallOf } from '@/config/features'
import type { NavItem } from '@/config/nav'
import { useViewSearch } from '@/app/viewSearch'
import { FeatureChip } from '@/ui/provenance/Chips'

interface Gap {
  /** What is still missing before this screen can show real data (in the backend, or in the console API). */
  missing: readonly string[]
  /** A document in the repository that describes the data (plain text: the console does not serve it). */
  doc?: string
}

const GAPS: Partial<Record<NavItem['id'], Gap>> = {
  customers: {
    missing: [
      'A console API for devices and for per-site detail (customers and sites are listed already).',
    ],
  },
}

/**
 * What a screen shows until it is designed. It states plainly that the screen
 * does not exist yet, what the backend does and does not provide for it, what
 * has to be set up, and what is missing, so nothing here can be mistaken for a working screen.
 */
export function ScreenPlaceholder({ item }: { item: NavItem }) {
  const search = useViewSearch()
  const feature = item.feature ? FEATURES[item.feature] : null
  const gap = GAPS[item.id]

  return (
    <article className="flex max-w-prose flex-col gap-3 rounded-sm border border-dashed border-border-strong bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="type-title">{item.label}</h1>
        {feature && isPlaceholder(feature.id) ? (
          <FeatureChip availability={shortfallOf(feature.id) ?? 'unknown'} title={feature.note} />
        ) : null}
      </header>
      <p className="type-body-strong">This screen has not been designed yet</p>
      <p className="type-body text-fg-muted">{item.description}.</p>

      {feature ? (
        <section className="flex flex-col gap-1">
          <h2 className="type-label text-fg-muted">Backend status</h2>
          <p className="type-data text-fg">{describeAvailability(feature.id)}</p>
          <p className="type-body text-fg-muted">{feature.note}</p>
        </section>
      ) : null}

      {feature?.requires ? (
        <section className="flex flex-col gap-1">
          <h2 className="type-label text-fg-muted">Prerequisites</h2>
          <p className="type-body text-fg-muted">
            For the backend to have data: {feature.requires}. Doing this does not show data in this
            console: it is not connected to it yet.
          </p>
        </section>
      ) : null}

      {gap ? (
        <section className="flex flex-col gap-1">
          <h2 className="type-label text-fg-muted">Not available yet</h2>
          <ul className="type-body flex list-disc flex-col gap-1 pl-5 text-fg-muted">
            {gap.missing.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {gap?.doc ? (
        <section className="flex flex-col gap-1">
          <h2 className="type-label text-fg-muted">Documentation</h2>
          <p className="type-body text-fg-muted">
            See <code className="type-data text-fg">{gap.doc}</code> in the repository.
          </p>
        </section>
      ) : null}

      <Link
        to={{ pathname: '/', search }}
        className="type-data-strong w-fit text-primary underline underline-offset-2 hover:text-primary-hover"
      >
        Back to Overview
      </Link>
    </article>
  )
}
