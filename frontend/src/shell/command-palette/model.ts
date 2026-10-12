import { AtSign, Hash, Terminal, type LucideIcon } from 'lucide-react'
import type { EntityIndexItem, EntityKind, HealthStatus } from '@/api/types'
import { isUnimplemented } from '@/config/features'
import { NAV_ITEMS, type NavItem } from '@/config/nav'
import { compareSeverity, needsAttention } from '@/lib/status'
import { containsScore, fuzzyScore } from './fuzzy'
import type { ParsedQuery, Scope } from './query'

export type GroupId =
  'problems' | 'entities' | 'sites' | 'go-to' | 'actions' | 'scenario' | 'planned' | 'help'

export const GROUP_LABEL: Record<GroupId, string> = {
  problems: 'Problems',
  entities: 'Entities',
  sites: 'Sites and customers',
  'go-to': 'Go to',
  actions: 'Actions',
  scenario: 'Mock scenario',
  planned: 'Planned',
  help: 'Help',
}

export interface PaletteItem {
  /** Unique across the whole palette; used as the React key. */
  id: string
  group: GroupId
  title: string
  /** Customer and site names are prose a person wrote (sans); every other title is mono. */
  prose?: boolean
  subtitle?: string
  icon: LucideIcon
  /** More text to match, at a lower weight than the title. */
  keywords?: readonly string[]
  /** Set on entities: the worst-state tag in the right slot, and the severity tie-break. */
  status?: HealthStatus
  kind?: EntityIndexItem['kind']
  /** Right-slot tag for things the backend does not do (or does not yet), or the active scenario. */
  badge?: 'plan' | 'planned' | 'current'
  /** Keycaps for the item's own shortcut. */
  hint?: readonly string[]
  /** What Enter does. null: selectable but inert, it only explains itself (PLANNED items). */
  run: (() => void) | null
  /** Keep the palette open after running (the help rows fill the input instead). */
  keepOpen?: boolean
}

export interface PaletteGroup {
  id: GroupId
  label: string
  items: PaletteItem[]
}

/** Everything the palette can offer, before the query narrows it. */
export type PaletteSource = Record<Exclude<GroupId, 'problems'>, readonly PaletteItem[]>

export const PROBLEM_LIMIT = 5
/** Per group: a one-letter query must not render the whole fleet. */
export const GROUP_LIMIT = 30
/**
 * A match in a detail, a site or a customer counts for less than the same match in the name,
 * and it must be a contiguous substring (see containsScore).
 */
const KEYWORD_WEIGHT = 0.6

function navItem(id: NavItem['id']): NavItem {
  const item = NAV_ITEMS.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`NAV_ITEMS has no "${id}" screen`)
  return item
}

const DOMAIN_SCREEN: Record<EntityIndexItem['kind'], NavItem['id']> = {
  server: 'servers',
  container: 'docker',
  target: 'network',
  device: 'snmp',
  site: 'customers',
  customer: 'customers',
}

/** The screen that owns an entity: where Enter takes you. */
export function screenOf(kind: EntityIndexItem['kind']): NavItem {
  return navItem(DOMAIN_SCREEN[kind])
}

function isEntityKind(kind: EntityIndexItem['kind']): kind is EntityKind {
  return kind !== 'site' && kind !== 'customer'
}

export function entityItem(
  entity: EntityIndexItem,
  open: (entity: EntityIndexItem) => void,
): PaletteItem {
  const prose = !isEntityKind(entity.kind)
  // A site's own name is already the title, and a customer has no parent to show.
  const place =
    entity.kind === 'site'
      ? entity.customerName
      : entity.kind === 'customer'
        ? undefined
        : entity.siteName
  return {
    id: `${entity.kind}:${entity.id}`,
    group: prose ? 'sites' : 'entities',
    title: entity.name,
    prose,
    subtitle: [entity.kind, entity.detail, place].filter(Boolean).join(' · '),
    icon: screenOf(entity.kind).icon,
    keywords: [entity.detail, entity.siteName, entity.customerName].filter((text): text is string =>
      Boolean(text),
    ),
    status: entity.status,
    kind: entity.kind,
    run: () => open(entity),
  }
}

export function screenItems(open: (screen: NavItem) => void, showKeys: boolean): PaletteItem[] {
  return NAV_ITEMS.map((screen) => ({
    id: `go-to:${screen.id}`,
    group: 'go-to',
    title: screen.label,
    subtitle: screen.description,
    icon: screen.icon,
    hint: showKeys ? ['g', screen.chord] : undefined,
    badge: screen.feature !== null && isUnimplemented(screen.feature) ? 'plan' : undefined,
    run: () => open(screen),
  }))
}

const HELP_ROWS = [
  {
    prefix: '>',
    title: 'Actions',
    subtitle: 'Run a command: pause, refresh, time range',
    icon: Terminal,
  },
  {
    prefix: '@',
    title: 'Entities',
    subtitle: 'Servers, containers, targets and devices',
    icon: AtSign,
  },
  {
    prefix: '#',
    title: 'Sites and customers',
    subtitle: 'Jump to a site or a customer',
    icon: Hash,
  },
] as const

/** The "?" help: one row per prefix, and choosing it types the prefix for you. */
export function helpItems(choose: (prefix: string) => void): PaletteItem[] {
  return HELP_ROWS.map(({ prefix, title, subtitle, icon }) => ({
    id: `help:${prefix}`,
    group: 'help',
    title,
    subtitle,
    icon,
    hint: [prefix],
    keepOpen: true,
    run: () => choose(prefix),
  }))
}

/**
 * The triage launcher: the worst non-healthy entities of the domains the
 * backend really implements. Devices (SNMP is planned and asserts nothing),
 * sites and customers (roll-ups of the same entities) and alerts never appear.
 */
export function problemItems(entities: readonly PaletteItem[]): PaletteItem[] {
  return entities
    .filter(({ kind, status }) => {
      if (kind === undefined || !isEntityKind(kind) || status === undefined) return false
      const { feature } = screenOf(kind)
      return feature !== null && !isUnimplemented(feature) && needsAttention(status)
    })
    .sort((a, b) => compareSeverity(statusOf(a), statusOf(b)))
    .slice(0, PROBLEM_LIMIT)
    .map((item) => ({ ...item, id: `problem:${item.id}`, group: 'problems' }))
}

const statusOf = (item: PaletteItem): HealthStatus => item.status ?? 'healthy'

/** Empty query: which groups each scope lists, in order. */
const BROWSE: Record<Scope, readonly GroupId[]> = {
  all: ['problems', 'go-to', 'actions', 'scenario', 'planned'],
  goto: ['go-to'],
  entities: ['entities', 'sites'],
  actions: ['actions', 'scenario', 'planned'],
  sites: ['sites'],
  help: ['help'],
}

/** Typed query: the same, except everything searchable is on offer (and problems are not). */
const SEARCH: Record<Scope, readonly GroupId[]> = {
  ...BROWSE,
  all: ['entities', 'sites', 'go-to', 'actions', 'scenario', 'planned'],
}

function scoreItem(text: string, item: PaletteItem): number | null {
  let best = fuzzyScore(text, item.title)
  for (const keyword of item.keywords ?? []) {
    const score = containsScore(text, keyword)
    if (score !== null && (best === null || score * KEYWORD_WEIGHT > best))
      best = score * KEYWORD_WEIGHT
  }
  return best
}

interface Ranked {
  item: PaletteItem
  score: number
}

/** Best match first; equal scores go to the worse state, so "ed" lists edge-gw-02 (CRIT) before edge-gw-01 (OK). */
function rank(text: string, items: readonly PaletteItem[]): Ranked[] {
  const ranked: Ranked[] = []
  for (const item of items) {
    const score = scoreItem(text, item)
    if (score !== null) ranked.push({ item, score })
  }
  return ranked.sort(
    (a, b) => b.score - a.score || compareSeverity(statusOf(a.item), statusOf(b.item)),
  )
}

/**
 * What the palette shows for a query.
 *
 * No text: each group of the scope in its fixed order (entities worst first).
 * Text: only the matches, best first inside a group, and the group holding the
 * best match first, so Enter on the top row does the most likely thing.
 */
export function buildGroups(source: PaletteSource, { scope, text }: ParsedQuery): PaletteGroup[] {
  const pool = (id: GroupId): readonly PaletteItem[] =>
    id === 'problems' ? problemItems(source.entities) : source[id]

  if (text === '') {
    return BROWSE[scope]
      .map((id): PaletteGroup => {
        const items = pool(id)
        // Only entity lists have a state to sort by; the rest keep their written order.
        const ordered =
          id === 'entities' || id === 'sites'
            ? [...items].sort((a, b) => compareSeverity(statusOf(a), statusOf(b)))
            : items
        return { id, label: GROUP_LABEL[id], items: ordered.slice(0, GROUP_LIMIT) }
      })
      .filter((group) => group.items.length > 0)
  }

  return SEARCH[scope]
    .map((id) => ({ id, ranked: rank(text, pool(id)).slice(0, GROUP_LIMIT) }))
    .filter(({ ranked }) => ranked.length > 0)
    .sort((a, b) => (b.ranked[0]?.score ?? 0) - (a.ranked[0]?.score ?? 0))
    .map(({ id, ranked }) => ({
      id,
      label: GROUP_LABEL[id],
      items: ranked.map(({ item }) => item),
    }))
}
