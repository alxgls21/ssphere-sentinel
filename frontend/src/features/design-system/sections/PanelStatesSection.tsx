import type { DisplayStatus } from '@/lib/status'
import { POLL_MS } from '@/lib/thresholds'
import { Panel, type PanelProps } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { SAMPLE_TIME } from '../sample/data'
import { noop } from '../sample/noop'
import { Specimen } from '../Specimen'

const ROWS: readonly { status: DisplayStatus; word: string; name: string }[] = [
  { status: 'offline', word: 'OFFLINE', name: 'edge-gw-02' },
  { status: 'warning', word: 'DEGRADED', name: 'acme-vpn:443' },
  { status: 'healthy', word: 'ONLINE', name: 'api-02' },
]

/** The same static content in every state, so only the state differs from one panel to the next. */
function SampleRows() {
  return (
    <ul className="flex flex-col gap-2">
      {ROWS.map(({ status, word, name }) => (
        <li key={name} className="flex items-center gap-3">
          <StatusTag status={status} word={word} variant="tag" className="w-24" />
          <span className="type-data-strong">{name}</span>
        </li>
      ))}
    </ul>
  )
}

const FAILURE = new Error('Request failed with status 503')

interface StateSample {
  /** The state's name, as the caption above it. */
  state: string
  note: string
  panel: Omit<PanelProps, 'className' | 'refreshMs'>
}

/**
 * One panel per state. Titles differ because each is a labelled region and two
 * regions with one name are indistinguishable to a screen reader.
 */
const STATES: readonly StateSample[] = [
  {
    state: 'Ready',
    note: 'The numbered keycap, count, scope, then the quiet source tag.',
    panel: {
      title: 'Fleet load',
      features: 'servers',
      index: 3,
      count: 3,
      scope: 'NOW',
      footer: <span>3 of 3 servers</span>,
      children: <SampleRows />,
    },
  },
  {
    state: 'Loading',
    note: 'A skeleton appears only after 150ms and never on a refetch. The header and frame never move.',
    panel: { title: 'Probe latency', features: 'network', scope: '1h', status: 'loading' },
  },
  {
    state: 'Empty',
    note: 'Success with nothing to show. A positive empty state wears the OK glyph.',
    panel: {
      title: 'Needs attention',
      features: 'servers',
      isEmpty: true,
      empty: (
        <EmptyState glyph="healthy" title="Nothing needs attention" hint="Checked 14:05:12Z" />
      ),
    },
  },
  {
    state: 'Error',
    note: 'Inline and recoverable: announced once, with Retry.',
    panel: {
      title: 'Infrastructure health',
      features: 'servers',
      status: 'error',
      error: FAILURE,
      onRetry: noop,
    },
  },
  {
    state: 'Refreshing',
    note: 'A reload is in flight: the previous content stays at 60% opacity and nothing shifts.',
    panel: {
      title: 'Docker hosts',
      features: 'docker',
      refreshing: true,
      children: <SampleRows />,
    },
  },
  {
    state: 'Stale',
    note: 'The data is older than the stale threshold: dimmed and named STALE.',
    panel: { title: 'Probe targets', features: 'network', stale: true, children: <SampleRows /> },
  },
  {
    state: 'Planned',
    note: 'The backend has no alert engine: dashed frame, PLANNED chip, muted values, and one footer sentence.',
    panel: {
      title: 'Active alerts',
      features: 'alerts',
      plannedNote: 'Alert engine not implemented.',
      children: <SampleRows />,
    },
  },
  {
    state: 'Refresh failed',
    note: 'The last good data stays visible under a non-blocking banner that says when it is from.',
    panel: {
      title: 'Servers',
      features: 'servers',
      error: FAILURE,
      updatedAt: SAMPLE_TIME,
      onRetry: noop,
      children: <SampleRows />,
    },
  },
]

export function PanelStatesSection() {
  return (
    <div className="grid gap-x-3 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
      {STATES.map(({ state, note, panel }) => (
        <Specimen key={state} label={state} note={note} bare>
          <Panel {...panel} refreshMs={POLL_MS} className="h-56" />
        </Specimen>
      ))}
    </div>
  )
}
