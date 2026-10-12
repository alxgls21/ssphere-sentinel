import { Link } from 'react-router'
import { FEATURES, isUnimplemented, type Readiness } from '@/config/features'
import type { NavItem } from '@/config/nav'
import { useViewSearch } from '@/app/viewSearch'
import { PlannedChip } from '@/ui/provenance/Chips'

const READINESS_LABEL: Record<Readiness, string> = {
  ingest: 'Agent data is stored; nothing reads it back yet',
  partial: 'Partly implemented in the backend',
  'admin-only': 'Managed in the Django admin only',
  planned: 'Not implemented in the backend',
}

interface Gap {
  /** What the backend still has to provide before this screen can show real data. */
  missing: readonly string[]
  /** A document in the repository that describes the data (plain text: the console does not serve it). */
  doc?: string
}

const GAPS: Partial<Record<NavItem['id'], Gap>> = {
  docker: {
    missing: [
      'A read API for containers and Docker hosts.',
      'An expected state or restart policy and the exit code in the Docker report, so a crashed container can be told from a finished job.',
    ],
    doc: 'docs/agent-deployment.md',
  },
  network: {
    missing: [
      'A read API for probe targets and their measurements.',
      'Latency percentiles (p50, p95) per time bucket: the backend stores raw measurements and does not aggregate them.',
      'A Site link on probe targets.',
    ],
    doc: 'docs/agent-deployment.md',
  },
  snmp: {
    missing: [
      'The agent-side SNMP collector: no device reports data yet.',
      'A read API for devices, interfaces and counters.',
    ],
    doc: 'docs/snmp.md',
  },
  topology: {
    missing: [
      'A topology model: links between devices, servers and sites.',
      'Outage-impact analysis built on it.',
    ],
  },
  alerts: {
    missing: [
      'An alert engine with rules, acknowledgement and notification.',
      'State-change history and an event log: the backend keeps only the latest state of each entity.',
    ],
  },
  customers: {
    missing: [
      'A read API for customers, sites and devices (they are managed in the Django admin today).',
      'A Site link on servers and probe targets.',
    ],
  },
}

/**
 * What a screen shows until it is designed. It states plainly that the screen
 * does not exist yet, what the backend does and does not provide for it, and
 * what is missing, so nothing here can be mistaken for a working screen.
 */
export function ScreenPlaceholder({ item }: { item: NavItem }) {
  const search = useViewSearch()
  const feature = item.feature ? FEATURES[item.feature] : null
  const gap = GAPS[item.id]

  return (
    <article className="flex max-w-prose flex-col gap-3 rounded-sm border border-dashed border-border-strong bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="type-title">{item.label}</h1>
        {feature && isUnimplemented(feature.id) ? <PlannedChip /> : null}
      </header>
      <p className="type-body-strong">This screen has not been designed yet</p>
      <p className="type-body text-fg-muted">{item.description}.</p>

      {feature ? (
        <section className="flex flex-col gap-1">
          <h2 className="type-label text-fg-muted">Backend status</h2>
          <p className="type-data text-fg">{READINESS_LABEL[feature.readiness]}</p>
          <p className="type-body text-fg-muted">{feature.note}</p>
        </section>
      ) : null}

      {gap ? (
        <section className="flex flex-col gap-1">
          <h2 className="type-label text-fg-muted">Missing in the backend</h2>
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
